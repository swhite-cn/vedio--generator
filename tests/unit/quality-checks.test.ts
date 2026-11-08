import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopyDocV2, SceneSpecV2, ThemeV2, TimelineDocV2 } from "@videoforge/shared";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  checkAnimationDurations,
  checkContrast,
  checkFreeze,
  checkSourceLabels,
  checkSubtitleOverflow,
  contrastRatio,
  parseFreezeIntervals,
  runQualityChecks,
} from "../../packages/pipeline/src/quality/checks";

/** 构造最小合法 v2 主题。 */
function makeTheme(overrides: Partial<ThemeV2> = {}): ThemeV2 {
  return {
    id: "test-theme",
    name: "测试主题",
    frame: { width: 1920, height: 1080, safe_area: 0.05 },
    tokens: {
      text: "#EAECEF",
      background: "#101216",
      accent: "#E4B95B",
      secondary: [],
      font_family: "Noto Sans SC",
      title_size: 72,
      body_size: 40,
      caption: { size: 36, stroke: 2, bottom_ratio: 0.08, max_chars_per_line: 18 },
    },
    motion: { min_duration_ms: 300, max_duration_ms: 800 },
    ...overrides,
  };
}

/** 构造最小 timeline v2。 */
function makeTimeline(): TimelineDocV2 {
  return {
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
  };
}

/** 构造 copy v2 场景镜头（默认数据组件、无来源）。 */
function makeCopyShot(overrides: Record<string, unknown> = {}): CopyDocV2["scenes"][number]["shots"][number] {
  return {
    shotId: "sh-001",
    narration: "口播",
    onScreenText: "",
    emphasis: [],
    visualType: "component",
    component: { id: "data-card", params: {} },
    assetRefs: [],
    anchorKeys: [],
    ...overrides,
  };
}

/** 构造 SceneSpec 镜头。 */
function makeSpecShot(overrides: Record<string, unknown> = {}): SceneSpecV2["shots"][number] {
  return {
    shotId: "sh-001",
    visualType: "component",
    componentId: "data-card",
    props: {},
    assetRefs: [],
    transition: { in: "hard-cut", out: "hard-cut" },
    animations: [],
    source: null,
    ...overrides,
  };
}

/** 构造旁白 cue。 */
function makeCue(text: string, shotId = "sh-001") {
  return { cueId: `cue-${shotId}`, shotId, kind: "narration" as const, startMs: 0, endMs: 1000, text };
}

describe("contrastRatio（WCAG 对比度）", () => {
  it("黑对白为 21:1，同色为 1:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#808080", "#808080")).toBeCloseTo(1, 5);
  });

  it("方向无关（亮暗顺序不影响结果）", () => {
    expect(contrastRatio("#EAECEF", "#101216")).toBeCloseTo(contrastRatio("#101216", "#EAECEF"), 6);
  });
});

describe("checkSubtitleOverflow（阻断）", () => {
  it("正例：单行字数内通过", () => {
    const theme = makeTheme();
    const check = checkSubtitleOverflow([makeCue("黑洞是时空的极端弯曲")], theme);
    expect(check.status).toBe("pass");
    expect(check.violations).toEqual([]);
  });

  it("反例：超过 max_chars_per_line 即 fail 并定位镜头", () => {
    const theme = makeTheme();
    const longText = "这是一个远远超过十八个字数上限的口播字幕文本内容";
    const check = checkSubtitleOverflow([makeCue(longText), makeCue("短的", "sh-002")], theme);
    expect(check.status).toBe("fail");
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0]!.shotId).toBe("sh-001");
    expect(check.violations[0]!.detail).toContain("上限 18");
  });
});

describe("checkSourceLabels（阻断）", () => {
  const theme = makeTheme();

  it("正例：数据组件提供 SceneSpec source 通过", () => {
    const copy = {
      contractVersion: "2.0",
      topic: "黑洞",
      style: "科普",
      title: "黑洞",
      theme: { id: "t" },
      styleAnchors: [],
      scenes: [{ sceneId: "s1", title: "开篇", shots: [makeCopyShot()] }],
    } as CopyDocV2;
    const spec = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [makeSpecShot({ source: { label: "CERN 公开资料" } })],
    } as SceneSpecV2;
    expect(checkSourceLabels(copy, spec).status).toBe("pass");
  });

  it("反例：数据组件无任何来源即 fail；回退 copy.sourceRef 可通过", () => {
    const copy = {
      contractVersion: "2.0",
      topic: "黑洞",
      style: "科普",
      title: "黑洞",
      theme: { id: "t" },
      styleAnchors: [],
      scenes: [{ sceneId: "s1", title: "开篇", shots: [makeCopyShot()] }],
    } as CopyDocV2;
    const spec = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [makeSpecShot()],
    } as SceneSpecV2;
    const missing = checkSourceLabels(copy, spec);
    expect(missing.status).toBe("fail");
    expect(missing.violations[0]!.shotId).toBe("sh-001");

    const fallbackCopy = {
      ...copy,
      scenes: [
        {
          sceneId: "s1",
          title: "开篇",
          shots: [makeCopyShot({ sourceRef: { label: "NASA" } })],
        },
      ],
    } as unknown as CopyDocV2;
    expect(checkSourceLabels(fallbackCopy, spec).status).toBe("pass");
  });

  it("非数据组件（keyword-block）无来源不违规", () => {
    const copy = {
      contractVersion: "2.0",
      topic: "黑洞",
      style: "科普",
      title: "黑洞",
      theme: { id: "t" },
      styleAnchors: [],
      scenes: [
        { sceneId: "s1", title: "开篇", shots: [makeCopyShot({ component: { id: "keyword-block", params: {} } })] },
      ],
    } as CopyDocV2;
    const spec = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [makeSpecShot({ componentId: "keyword-block" })],
    } as SceneSpecV2;
    expect(checkSourceLabels(copy, spec).status).toBe("pass");
  });
});

describe("checkContrast（警告）", () => {
  it("正例：暗色主题对比度达标", () => {
    expect(checkContrast(makeTheme()).status).toBe("pass");
  });

  it("反例：低对比主题 fail 并给出实测比值", () => {
    const theme = makeTheme({
      tokens: {
        text: "#8A8A8A",
        background: "#808080",
        accent: "#E4B95B",
        secondary: [],
        font_family: "Noto Sans SC",
        title_size: 72,
        body_size: 40,
        caption: { size: 36, stroke: 2, bottom_ratio: 0.08, max_chars_per_line: 18 },
      },
    });
    const check = checkContrast(theme);
    expect(check.status).toBe("warn");
    expect(check.violations[0]!.detail).toContain("1.14:1");
    expect(check.violations[0]!.detail).toContain("7.2:1");
  });
});

describe("checkAnimationDurations（警告）", () => {
  it("正例：合法动效通过；scene 未跑返回 pass", () => {
    const spec = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [
        makeSpecShot({ animations: [{ effect: "title-in", atMs: 100, durationMs: 400 }] }),
      ],
    } as SceneSpecV2;
    expect(checkAnimationDurations(makeTimeline(), spec, makeTheme()).status).toBe("pass");
    expect(checkAnimationDurations(makeTimeline(), null, makeTheme()).status).toBe("pass");
  });

  it("反例：时长超出主题边界与越出镜头边界均为 warn（方案 §7.4 警告级）", () => {
    const theme = makeTheme();
    const outOfRange = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [
        makeSpecShot({ animations: [{ effect: "too-short", atMs: 0, durationMs: 200 }] }),
      ],
    } as unknown as SceneSpecV2;
    const rangeCheck = checkAnimationDurations(makeTimeline(), outOfRange, theme);
    expect(rangeCheck.status).toBe("warn");
    expect(rangeCheck.violations[0]!.detail).toContain("超出 [300, 800]");

    const clipped = {
      contractVersion: "2.0",
      themeId: "t",
      shots: [
        makeSpecShot({ animations: [{ effect: "late", atMs: 900, durationMs: 400 }] }),
      ],
    } as SceneSpecV2;
    const check = checkAnimationDurations(makeTimeline(), clipped, theme);
    expect(check.status).toBe("warn");
    expect(check.violations[0]!.detail).toContain("越界");
  });
});

describe("parseFreezeIntervals / checkFreeze", () => {
  /** 构造以指定 stderr 与退出码结束的假子进程。 */
  function fakeProcess(stderr: string, code: number) {
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    });
    return proc;
  }

  afterEach(() => vi.mocked(spawn).mockReset());

  it("解析 freeze_start/duration 成对输出；不成对忽略", () => {
    const stderr = [
      "[freezedetect @ 0x0] freeze_start: 0.5",
      "[freezedetect @ 0x0] freeze_duration: 1.25",
      "[freezedetect @ 0x0] freeze_end: 1.75",
      "[freezedetect @ 0x0] freeze_start: 3",
    ].join("\n");
    expect(parseFreezeIntervals(stderr)).toEqual([{ startMs: 500, durationMs: 1250 }]);
  });

  it("整镜覆盖 ≥80% 判违规并映射镜头；部分静止（动效后稳定）不报", async () => {
    // 冻结 1.2–2.0s，与 sh-002（1000–2000ms）重叠 800ms = 80% → 违规
    vi.mocked(spawn).mockImplementation(() =>
      fakeProcess(
        "[freezedetect @ 0x0] freeze_start: 1.2\n[freezedetect @ 0x0] freeze_duration: 0.8",
        0,
      ) as never,
    );
    const dir = mkdtempSync(join(tmpdir(), "vf-freeze-"));
    try {
      const check = await checkFreeze({
        ffmpegPath: "ffmpeg",
        framesPattern: join(dir, "frames", "%08d.jpeg"),
        fps: 30,
        timeline: makeTimeline(),
        logPath: join(dir, "freeze.log"),
      });
      expect(check.status).toBe("warn");
      expect(check.violations[0]!.shotId).toBe("sh-002");
      expect(check.violations[0]!.detail).toContain("静帧覆盖率 80%");

      // 动效后的短暂静止（300ms = 30% 覆盖）不构成违规
      vi.mocked(spawn).mockImplementation(() =>
        fakeProcess(
          "[freezedetect @ 0x0] freeze_start: 0.1\n[freezedetect @ 0x0] freeze_duration: 0.3",
          0,
        ) as never,
      );
      const partial = await checkFreeze({
        ffmpegPath: "ffmpeg",
        framesPattern: join(dir, "frames", "%08d.jpeg"),
        fps: 30,
        timeline: makeTimeline(),
        logPath: join(dir, "freeze.log"),
      });
      expect(partial.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skipShotIds（image 类整镜静止属预期）不参与静帧判定", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      fakeProcess(
        "[freezedetect @ 0x0] freeze_start: 0\n[freezedetect @ 0x0] freeze_duration: 2.5",
        0,
      ) as never,
    );
    const dir = mkdtempSync(join(tmpdir(), "vf-freeze-"));
    try {
      const check = await checkFreeze({
        ffmpegPath: "ffmpeg",
        framesPattern: join(dir, "frames", "%08d.jpeg"),
        fps: 30,
        timeline: makeTimeline(),
        logPath: join(dir, "freeze.log"),
        skipShotIds: ["sh-001", "sh-002"],
      });
      expect(check.status).toBe("pass");
      expect(check.violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ffmpeg 失败降级为 warn（不抛错）", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeProcess("boom", 2) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-freeze-"));
    try {
      const check = await checkFreeze({
        ffmpegPath: "ffmpeg",
        framesPattern: "x",
        fps: 30,
        timeline: makeTimeline(),
        logPath: join(dir, "freeze.log"),
      });
      expect(check.status).toBe("warn");
      expect(check.violations[0]!.detail).toContain("执行失败");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runQualityChecks（组合入口）", () => {
  /** 构造 v2 项目产物目录。 */
  function setupProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-quality-"));
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
            shots: [makeCopyShot({ shotId: "sh-001" }), makeCopyShot({ shotId: "sh-002", component: { id: "keyword-block", params: {} } })],
          },
        ],
      }),
      "utf-8",
    );
    writeFileSync(join(dir, "timeline.json"), JSON.stringify(makeTimeline()), "utf-8");
    writeFileSync(
      join(dir, "theme.resolved.json"),
      JSON.stringify({ version: "1", themeId: "t", resolvedAt: "2026-11-07T00:00:00.000Z", theme: makeTheme() }),
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
        cues: [makeCue("黑洞是时空的极端弯曲")],
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
          makeSpecShot({
            shotId: "sh-001",
            source: { label: "CERN 公开资料" },
            animations: [{ effect: "title-in", atMs: 0, durationMs: 400 }],
          }),
          makeSpecShot({ shotId: "sh-002", componentId: "keyword-block" }),
        ],
      }),
      "utf-8",
    );
    return dir;
  }

  afterEach(() => vi.mocked(spawn).mockReset());

  it("产物齐备：返回字幕溢出/来源/对比度/动效 4 项（未传帧 pattern 时跳过静帧）", async () => {
    const dir = setupProject();
    try {
      const checks = await runQualityChecks({ projectDir: dir });
      expect(checks.map((check) => check.id).sort()).toEqual([
        "animation-duration",
        "contrast",
        "source-label",
        "subtitle-overflow",
      ]);
      expect(checks.every((check) => check.status === "pass")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copy 为 v1 时抛 ADAPTER_PROTOCOL_INVALID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-quality-v1-"));
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
      await expect(runQualityChecks({ projectDir: dir })).rejects.toThrowError(/v2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
