import { describe, expect, test } from "vitest";
import type { ThemeV2, TimelineDocV2 } from "@videoforge/shared";
import {
  buildShotFramePlan,
  msToFrame,
  selectShotPlans,
} from "../../packages/remotion-engine/src/frames";
import { resolveRemotionTheme } from "../../packages/remotion-engine/src/theme";

/** 构造最小合法 v2 主题（与 config/themes/documentary-dark 同构）。 */
function makeTheme(overrides: Partial<ThemeV2> = {}): ThemeV2 {
  return {
    id: "test-theme",
    name: "测试主题",
    frame: { width: 1920, height: 1080, safe_area: 0.05 },
    tokens: {
      text: "#EAECEF",
      background: "#101216",
      accent: "#E4B95B",
      secondary: ["#20242C"],
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
function makeTimeline(shots: TimelineDocV2["shots"], fps = 30): TimelineDocV2 {
  return {
    contractVersion: "2.0",
    fps,
    tailPauseMs: 500,
    timingSource: "estimated",
    totalMs: shots[shots.length - 1]?.endMs ?? 0,
    shots,
    cues: [],
  };
}

describe("resolveRemotionTheme", () => {
  test("主题 token 确定性映射，无魔法值", () => {
    const theme = resolveRemotionTheme(makeTheme());
    expect(theme).toMatchObject({
      id: "test-theme",
      width: 1920,
      height: 1080,
      safePaddingPx: Math.round(1080 * 0.05),
      color: "#EAECEF",
      background: "#101216",
      accent: "#E4B95B",
      fontFamily: "Noto Sans SC",
      titleSizePx: 72,
      bodySizePx: 40,
      captionSizePx: 36,
      captionMaxCharsPerLine: 18,
      motion: { minDurationMs: 300, maxDurationMs: 800 },
    });
  });

  test("安全边距按宽高较小值计算", () => {
    const theme = resolveRemotionTheme(
      makeTheme({ frame: { width: 1080, height: 1920, safe_area: 0.1 } }),
    );
    expect(theme.safePaddingPx).toBe(108);
  });
});

describe("msToFrame / buildShotFramePlan", () => {
  test("毫秒换帧向下取整，帧数至少 1", () => {
    expect(msToFrame(0, 30)).toBe(0);
    expect(msToFrame(1000, 30)).toBe(30);
    expect(msToFrame(500, 30)).toBe(15);
    expect(msToFrame(16, 30)).toBe(0);
    expect(msToFrame(-5, 30)).toBe(0);
  });

  test("timeline v2 换算为连续帧计划", () => {
    const plan = buildShotFramePlan(
      makeTimeline([
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 3000, durationMs: 3000 },
        { shotId: "sh-002", sceneId: "s1", startMs: 3000, endMs: 6100, durationMs: 3100 },
      ]),
    );
    expect(plan).toEqual([
      { shotId: "sh-001", sceneId: "s1", fromFrame: 0, durationInFrames: 90, startMs: 0, durationMs: 3000 },
      { shotId: "sh-002", sceneId: "s1", fromFrame: 90, durationInFrames: 93, startMs: 3000, durationMs: 3100 },
    ]);
  });

  test("极短镜头保底 1 帧；空时间轴返回空数组", () => {
    const plan = buildShotFramePlan(
      makeTimeline([
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 10, durationMs: 10 },
      ]),
    );
    expect(plan[0].durationInFrames).toBe(1);
    expect(buildShotFramePlan(makeTimeline([]))).toEqual([]);
  });
});

describe("selectShotPlans", () => {
  const plan = buildShotFramePlan(
    makeTimeline([
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 3000, durationMs: 3000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 3000, endMs: 6000, durationMs: 3000 },
    ]),
  );

  test("缺省/空数组渲染全部", () => {
    expect(selectShotPlans(plan)).toHaveLength(2);
    expect(selectShotPlans(plan, [])).toHaveLength(2);
  });

  test("按 shotIds 过滤并保持原顺序（镜头级重渲口径）", () => {
    expect(selectShotPlans(plan, ["sh-002"]).map((entry) => entry.shotId)).toEqual(["sh-002"]);
    expect(selectShotPlans(plan, ["sh-002", "sh-001"]).map((entry) => entry.shotId)).toEqual([
      "sh-001",
      "sh-002",
    ]);
    expect(selectShotPlans(plan, ["no-such"])).toEqual([]);
  });
});

describe("shotsCompositionPropsSchema（T204 imageByShot）", () => {
  test("imageByShot 接受 record 与 null；非法类型被拒", async () => {
    const { shotsCompositionPropsSchema } = await import(
      "../../packages/remotion-engine/src/entry"
    );
    const base = {
      fps: 30,
      theme: makeTheme(),
      timeline: makeTimeline([
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      ]),
      specShots: null,
      shotIds: null,
    };
    expect(shotsCompositionPropsSchema.parse({ ...base, imageByShot: null }).imageByShot).toBeNull();
    expect(
      shotsCompositionPropsSchema.parse({ ...base, imageByShot: { "sh-001": "sh-001.png" } })
        .imageByShot,
    ).toEqual({ "sh-001": "sh-001.png" });
    expect(
      shotsCompositionPropsSchema.safeParse({ ...base, imageByShot: { "sh-001": 42 } }).success,
    ).toBe(false);
  });
});
