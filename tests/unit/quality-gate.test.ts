import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { readQualityReport } from "@videoforge/pipeline";
import { runQualityGate } from "../../apps/server/src/domain/quality-gate";

/** 仓库根目录（runQualityGate 内部链路不读配置，仅占位一致性）。 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 构造以空输出、指定退出码结束的假子进程（freezedetect 无冻结）。 */
function fakeProcess(stderr: string, code: number) {
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

/**
 * 构造 v2 项目产物目录。
 * @param options.withSource 数据组件镜头是否带来源（决定 source-label 结论）
 * @returns 项目目录
 */
function setupProject(options: { withSource: boolean } = { withSource: true }): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-quality-gate-"));
  writeFileSync(
    join(dir, "copy.json"),
    JSON.stringify({
      contractVersion: "2.0",
      topic: "黑洞",
      style: "科普",
      title: "黑洞",
      theme: { id: "t" },
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
              imagePath: "images/sh-001.png",
            },
            {
              shotId: "sh-002",
              narration: "光也无法逃逸。",
              visualType: "component",
              component: { id: "data-card", params: {} },
            },
          ],
        },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "timeline.json"),
    JSON.stringify({
      contractVersion: "2.0",
      fps: 30,
      tailPauseMs: 0,
      timingSource: "estimated",
      totalMs: 2000,
      shots: [
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
        { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
      ],
      cues: [],
    }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "theme.resolved.json"),
    JSON.stringify({
      version: "1",
      themeId: "t",
      resolvedAt: "2026-11-07T00:00:00.000Z",
      theme: {
        id: "t",
        name: "测试",
        frame: { width: 1920, height: 1080, safe_area: 0.05 },
        tokens: {
          text: "#EAECEF",
          background: "#101216",
          accent: "#E4B95B",
          secondary: [],
          font_family: "Noto Sans SC",
          title_size: 72,
          body_size: 40,
          caption: { size: 36, stroke: 0, bottom_ratio: 0.08, max_chars_per_line: 18 },
        },
        motion: { min_duration_ms: 300, max_duration_ms: 800 },
      },
    }),
    "utf-8",
  );
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "audio", "cues.json"),
    JSON.stringify({
      contractVersion: "2.0",
      timingSource: "estimated",
      shots: [
        { shotId: "sh-001", sceneId: "s1", audioPath: "audio/sh-001.mp3", durationMs: 1000, startMs: 0, endMs: 1000 },
        { shotId: "sh-002", sceneId: "s1", audioPath: "audio/sh-002.mp3", durationMs: 1000, startMs: 1000, endMs: 2000 },
      ],
      cues: [
        { cueId: "cue-1", shotId: "sh-001", kind: "narration", startMs: 0, endMs: 1000, text: "黑洞是时空的极端弯曲" },
        { cueId: "cue-2", shotId: "sh-002", kind: "narration", startMs: 1000, endMs: 2000, text: "光也无法逃逸" },
      ],
    }),
    "utf-8",
  );
  mkdirSync(join(dir, "scenes"), { recursive: true });
  writeFileSync(
    join(dir, "scenes", "spec.json"),
    JSON.stringify({
      contractVersion: "2.0",
      themeId: "t",
      shots: [
        {
          shotId: "sh-001",
          visualType: "image",
          props: {},
          assetRefs: [],
          transition: { in: "hard-cut", out: "hard-cut" },
          animations: [],
          source: null,
        },
        {
          shotId: "sh-002",
          visualType: "component",
          componentId: "data-card",
          props: {},
          assetRefs: [],
          transition: { in: "hard-cut", out: "hard-cut" },
          animations: [{ effect: "title-in", atMs: 0, durationMs: 400 }],
          source: options.withSource ? { label: "CERN 公开资料" } : null,
        },
      ],
    }),
    "utf-8",
  );
  // compose 物化帧目录（存在即触发静帧检测，ffmpeg 已 mock）
  mkdirSync(join(dir, "build", "compose", "landscape", "frames"), { recursive: true });
  return dir;
}

describe("runQualityGate", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("产物齐备：5 项检查落盘 report.json，正例全 pass 且不阻断", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcess("", 0) as never);
    const projectDir = setupProject();
    try {
      const { report, summary } = await runQualityGate({
        projectDir,
        runId: "run-1",
        profile: "landscape-1080p",
        ffmpegPath: "ffmpeg",
      });

      expect(report.runId).toBe("run-1");
      expect(report.checks.map((check) => check.id)).toEqual([
        "freeze",
        "subtitle-overflow",
        "source-label",
        "contrast",
        "animation-duration",
      ]);
      expect(report.checks.every((check) => check.status === "pass")).toBe(true);
      expect(summary.blocking).toBe(false);
      // 报告确实落盘（用读取器读回校验）
      expect(existsSync(join(projectDir, "quality", "report.json"))).toBe(true);
      expect(readQualityReport(join(projectDir, "quality", "report.json")).runId).toBe("run-1");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("数据组件缺来源：source-label fail 且 summary.blocking=true", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcess("", 0) as never);
    const projectDir = setupProject({ withSource: false });
    try {
      const { summary } = await runQualityGate({
        projectDir,
        runId: "run-1",
        profile: "landscape-1080p",
        ffmpegPath: "ffmpeg",
      });
      expect(summary.failed).toBe(1);
      expect(summary.blocking).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("物化帧目录不存在：静帧检查 skipped，其余照常执行", async () => {
    const projectDir = setupProject();
    rmSync(join(projectDir, "build"), { recursive: true, force: true });
    try {
      const { report } = await runQualityGate({
        projectDir,
        runId: "run-2",
        profile: "landscape-1080p",
        ffmpegPath: "ffmpeg",
      });
      expect(report.checks.find((check) => check.id === "freeze")!.status).toBe("skipped");
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("copy 为 v1 时抛 ADAPTER_PROTOCOL_INVALID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-quality-gate-v1-"));
    try {
      writeFileSync(
        join(dir, "copy.json"),
        JSON.stringify({
          topic: "黑洞",
          style: "科普",
          title: "黑洞",
          scenes: [{ sceneId: "s1", title: "开篇", narration: "n", imagePrompt: "p" }],
        }),
        "utf-8",
      );
      await expect(
        runQualityGate({ projectDir: dir, runId: "r", profile: "landscape-1080p", ffmpegPath: "ffmpeg" }),
      ).rejects.toThrowError(/v2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
