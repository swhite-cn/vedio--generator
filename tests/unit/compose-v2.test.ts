import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineDocV2 } from "@videoforge/shared";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  composeVideoStepV2,
  materializeShotFrames,
} from "../../packages/pipeline/src/compose-video";

/** 仓库根目录（composeVideoStepV2 内部 loadSystemConfig 读 config/default.yaml）。 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 构造以指定退出码结束的假子进程（concatAudioFiles 与 composeVideo 都会读 stdout/stderr）。 */
function fakeProcessExit(stderr: string, code: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
  });
  return proc;
}

/** 构造最小 timeline v2：两镜头各 1s（30fps），尾停顿 500ms（15 帧）。 */
function makeTimeline(): TimelineDocV2 {
  return {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 500,
    timingSource: "estimated",
    totalMs: 2500,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
    ],
    cues: [],
  };
}

/** 在镜头帧目录写入指定数量的 element-N.jpeg（绝对帧号从 startFrame 起）。 */
function writeShotFrames(shotsDir: string, shotId: string, startFrame: number, count: number): void {
  const dir = join(shotsDir, shotId);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, `element-${startFrame + index}.jpeg`), "jpeg", "utf-8");
  }
}

describe("materializeShotFrames", () => {
  it("按时间轴顺序物化连续编号帧，含尾停顿重复末帧", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-materialize-"));
    try {
      const shotsDir = join(dir, "shots");
      writeShotFrames(shotsDir, "sh-001", 0, 30);
      // 第二镜头帧号从 30 起（Remotion 绝对帧号），目录内不连续编号验证按帧号排序
      writeShotFrames(shotsDir, "sh-002", 30, 30);

      const written = materializeShotFrames({
        shotsDir,
        timeline: makeTimeline(),
        outDir: join(dir, "compose", "frames"),
      });

      // 30 + 30 + 尾停顿 15 = 75
      expect(written).toBe(75);
      const files = readdirSync(join(dir, "compose", "frames")).sort();
      expect(files).toHaveLength(75);
      expect(files[0]).toBe("00000001.jpeg");
      expect(files[74]).toBe("00000075.jpeg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重跑幂等：清空旧物化帧后重建", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-materialize-"));
    try {
      const shotsDir = join(dir, "shots");
      writeShotFrames(shotsDir, "sh-001", 0, 30);
      writeShotFrames(shotsDir, "sh-002", 30, 30);
      const outDir = join(dir, "compose", "frames");
      const timeline = { ...makeTimeline(), tailPauseMs: 0 };
      materializeShotFrames({ shotsDir, timeline, outDir });
      writeFileSync(join(outDir, "99999999.jpeg"), "stale", "utf-8");

      materializeShotFrames({ shotsDir, timeline, outDir });

      expect(readdirSync(outDir)).toHaveLength(60);
      expect(existsSync(join(outDir, "99999999.jpeg"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("镜头帧目录缺失报 CONFIG_INVALID", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-materialize-"));
    try {
      expect(() =>
        materializeShotFrames({
          shotsDir: join(dir, "shots"),
          timeline: makeTimeline(),
          outDir: join(dir, "frames"),
        }),
      ).toThrowError(/sh-001/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("镜头帧数不足报 CONFIG_INVALID", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-materialize-"));
    try {
      const shotsDir = join(dir, "shots");
      writeShotFrames(shotsDir, "sh-001", 0, 10);

      expect(() =>
        materializeShotFrames({
          shotsDir,
          timeline: makeTimeline(),
          outDir: join(dir, "frames"),
        }),
      ).toThrowError(/帧数不足/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("composeVideoStepV2", () => {
  /** 构造 v2 项目 fixture（copy/timeline/镜头帧/字幕），并返回 compose 入参。 */
  function setupProject(): { projectDir: string; copyPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-v2-"));
    writeFileSync(
      join(dir, "copy.json"),
      JSON.stringify({
        contractVersion: "2.0",
        topic: "黑洞",
        style: "科普",
        title: "黑洞简介",
        theme: { id: "documentary-dark" },
        styleAnchors: [],
        scenes: [
          {
            sceneId: "s1",
            title: "开篇",
            shots: [
              {
                shotId: "sh-001",
                narration: "黑洞是时空的极端弯曲。",
                visualType: "image",
                audioPath: "audio/sh-001.mp3",
              },
              {
                shotId: "sh-002",
                narration: "光也无法逃逸。",
                visualType: "component",
                audioPath: "audio/sh-002.mp3",
              },
            ],
          },
        ],
      }),
      "utf-8",
    );
    writeFileSync(join(dir, "timeline.json"), JSON.stringify(makeTimeline()), "utf-8");
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(join(dir, "audio", "sh-001.mp3"), "mp3", "utf-8");
    writeFileSync(join(dir, "audio", "sh-002.mp3"), "mp3", "utf-8");
    writeShotFrames(join(dir, "build", "render", "landscape", "shots"), "sh-001", 0, 30);
    writeShotFrames(join(dir, "build", "render", "landscape", "shots"), "sh-002", 30, 30);
    mkdirSync(join(dir, "captions"), { recursive: true });
    writeFileSync(join(dir, "captions", "subtitle.ass"), "[Script Info]", "utf-8");
    return { projectDir: dir, copyPath: join(dir, "copy.json") };
  }

  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("concat 逐镜音频 + 物化帧 + loudnorm/ASS 默认烧录，cwd 指向项目目录", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcessExit("ok", 0) as never);
    const { projectDir, copyPath } = setupProject();
    try {
      const out = await composeVideoStepV2({
        rootDir: REPO_ROOT,
        copyPath,
        outFile: join(projectDir, "final.mp4"),
        profile: "LANDSCAPE_1080P",
        loudnessTarget: -16,
      });

      expect(out).toBe(join(projectDir, "final.mp4"));
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
      const composeArgs = (vi.mocked(spawn).mock.calls[1] as unknown as [string, string[]])[1];
      const filterIndex = composeArgs.indexOf("-filter_complex");
      const filter = composeArgs[filterIndex + 1]!;
      expect(filter).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
      expect(filter).toContain("apad");
      const vfIndex = composeArgs.indexOf("-vf");
      expect(composeArgs[vfIndex + 1]).toBe("ass=captions/subtitle.ass");
      expect(spawnArgsHaveCwd(projectDir)).toBe(true);
      // 帧目录物化成功（compose 输入 pattern 存在）
      expect(existsSync(join(projectDir, "build", "compose", "landscape", "frames"))).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("burnCaptions=false 时不烧录字幕，缺 ASS 也不报错", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcessExit("ok", 0) as never);
    const { projectDir, copyPath } = setupProject();
    rmSync(join(projectDir, "captions"), { recursive: true, force: true });
    try {
      await composeVideoStepV2({
        rootDir: REPO_ROOT,
        copyPath,
        outFile: join(projectDir, "final.mp4"),
        profile: "LANDSCAPE_1080P",
        burnCaptions: false,
      });
      const composeArgs = (vi.mocked(spawn).mock.calls[1] as unknown as [string, string[]])[1];
      expect(composeArgs).not.toContain("-vf");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("默认烧录但 ASS 缺失时报 CONFIG_INVALID", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcessExit("ok", 0) as never);
    const { projectDir, copyPath } = setupProject();
    rmSync(join(projectDir, "captions", "subtitle.ass"));
    try {
      await expect(
        composeVideoStepV2({
          rootDir: REPO_ROOT,
          copyPath,
          outFile: join(projectDir, "final.mp4"),
          profile: "LANDSCAPE_1080P",
        }),
      ).rejects.toThrowError(/字幕轨不存在/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("copy 为 v1 时报 ADAPTER_PROTOCOL_INVALID", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcessExit("ok", 0) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-v2-v1-"));
    try {
      const copyPath = join(dir, "copy.json");
      writeFileSync(
        copyPath,
        JSON.stringify({
          topic: "黑洞",
          style: "科普",
          title: "黑洞简介",
          scenes: [{ sceneId: "s1", title: "开篇", narration: "n", imagePrompt: "p" }],
        }),
        "utf-8",
      );
      await expect(
        composeVideoStepV2({
          rootDir: REPO_ROOT,
          copyPath,
          outFile: join(dir, "final.mp4"),
          profile: "LANDSCAPE_1080P",
        }),
      ).rejects.toThrowError(/v2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("镜头缺 audioPath 报 CONFIG_INVALID", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcessExit("ok", 0) as never);
    const { projectDir, copyPath } = setupProject();
    // 破坏第二镜头的 audioPath
    const copyRaw = JSON.parse(readFileSync(copyPath, "utf-8"));
    copyRaw.scenes[0].shots[1].audioPath = undefined;
    writeFileSync(copyPath, JSON.stringify(copyRaw), "utf-8");
    try {
      await expect(
        composeVideoStepV2({
          rootDir: REPO_ROOT,
          copyPath,
          outFile: join(projectDir, "final.mp4"),
          profile: "LANDSCAPE_1080P",
        }),
      ).rejects.toThrowError(/audioPath/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

/**
 * 检查 compose 的 spawn 调用是否带 cwd（ASS 相对路径基准）。
 * @param expected 期望的项目目录
 * @returns 命中返回 true
 */
function spawnArgsHaveCwd(expected: string): boolean {
  const options = vi.mocked(spawn).mock.calls[1]?.[2] as { cwd?: string } | undefined;
  return options?.cwd === expected;
}
