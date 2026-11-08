import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShotSpec, ThemeV2 } from "@videoforge/shared";
import { resolveRemotionTheme } from "../../packages/remotion-engine/src/theme";

/**
 * 组件 React 实现的单测（T202）。
 * remotion 的 useCurrentFrame/useVideoConfig 需要 Composition 上下文，这里 mock 为固定帧；
 * 用 renderToStaticMarkup 断言 DOM 结构与关键文本，不需要浏览器。
 */

// 固定帧 30（30fps 下 = 1s，入场动效已结束，进度为 1）；
// Sequence 在 SSR 下内部也会读 video config，这里替换为透传，让 ShotsComposition 可离线渲染
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useCurrentFrame: () => 30,
    useVideoConfig: () => ({
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 90,
      defaultProps: {},
    }),
    Sequence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const { ComponentShotVisual } = await import(
  "../../packages/remotion-engine/src/components/index"
);
const { entranceProgress } = await import(
  "../../packages/remotion-engine/src/components/common"
);

/** 构造最小合法 v2 主题（与单测 remotion-engine.test.ts 同构）。 */
function makeTheme(): ThemeV2 {
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
  };
}

/** 构造组件镜头 spec。 */
function makeComponentSpec(componentId: string, props: Record<string, unknown>): ShotSpec {
  return {
    shotId: "sh-001",
    visualType: "component",
    componentId,
    props,
    assetRefs: [],
    transition: { in: "hard-cut", out: "hard-cut" },
    animations: [],
    source: null,
  };
}

const theme = resolveRemotionTheme(makeTheme());

describe("entranceProgress（纯函数）", () => {
  test("帧 0 进度为 0，动效结束为 1，越界夹取", () => {
    expect(entranceProgress(0, 30, theme)).toBe(0);
    // 默认 400ms @30fps ≈ 12 帧
    expect(entranceProgress(12, 30, theme)).toBe(1);
    expect(entranceProgress(100, 30, theme)).toBe(1);
    // 期望 200ms 会被夹到主题下限 300ms（9 帧）
    expect(entranceProgress(0, 30, theme, 200)).toBe(0);
    expect(entranceProgress(9, 30, theme, 200)).toBe(1);
  });
});

describe("ComponentShotVisual 分发", () => {
  test("keyword-block：渲染主标题、副标题与下划线", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("keyword-block", {
          title: "孤独的神经元",
          subtitle: "信号如何在突触间放大",
          underline: "sweep",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("孤独的神经元");
    expect(html).toContain("信号如何在突触间放大");
    // accent 色下划线存在
    expect(html).toContain(theme.accent);
  });

  test("data-card：渲染指标名、数值、单位与趋势箭头", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("data-card", {
          label: "突触强度",
          value: "3.6",
          unit: "倍",
          caption: "对照实验均值",
          trend: "up",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("突触强度");
    expect(html).toContain("3.6");
    expect(html).toContain("倍");
    expect(html).toContain("对照实验均值");
    expect(html).toContain("↑");
  });

  test("quote-card：emphasis 高亮 + 落款", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("quote-card", {
          quote: "我们测量了水银的表面张力",
          author: "玛丽·居里",
          role: "物理学家",
          emphasis: "表面张力",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("我们测量了水银的");
    expect(html).toContain("表面张力");
    expect(html).toContain("玛丽·居里");
    expect(html).toContain("（物理学家）");
    // 高亮 span 使用 accent 色
    expect(html).toContain(theme.accent);
  });

  test("comparison-bars：按数值比例渲染两行条形", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("comparison-bars", {
          labelA: "实验组",
          valueA: "128",
          labelB: "对照组",
          valueB: "64",
          unit: "次/分",
          caption: "神经元放电频率对比",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("实验组");
    expect(html).toContain("128");
    expect(html).toContain("对照组");
    expect(html).toContain("64");
    expect(html).toContain("神经元放电频率对比");
  });

  test("progress-ring：SVG 圆环与中心百分比", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("progress-ring", {
          label: "测序完成度",
          percent: 76,
          caption: "人类基因组计划 · 2003",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("测序完成度");
    expect(html).toContain("76");
    // aria 标签携带百分比
    expect(html).toContain("测序完成度 76%");
  });

  test("chapter-badge：章节号 + 标题 + 副题", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("chapter-badge", {
          chapter: "02",
          title: "突触的秘密",
          subtitle: "信号如何在神经元之间传递",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("02");
    expect(html).toContain("突触的秘密");
    expect(html).toContain("信号如何在神经元之间传递");
  });

  test("source-tag：底部来源标注", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("source-tag", {
          label: "CERN 公开资料",
          note: "数据截至 2024 年",
        })}
        theme={theme}
      />,
    );
    expect(html).toContain("来源：CERN 公开资料");
    expect(html).toContain("数据截至 2024 年");
  });

  test("渲染层不做参数校验：超长 title 原样渲染（校验边界在装配期）", () => {
    const html = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("keyword-block", { title: "这是一个远远超过十八个字限制的标题文本" })}
        theme={theme}
      />,
    );
    expect(html).toContain("这是一个远远超过十八个字限制的标题文本");
  });

  test("数据组件带来源时叠加来源标签，非数据组件不叠加（T402）", () => {
    const dataCard = renderToStaticMarkup(
      <ComponentShotVisual
        spec={{
          ...makeComponentSpec("data-card", {
            label: "突触强度",
            value: "3.6",
            unit: "倍",
          }),
          source: { label: "CERN 公开资料", note: "数据截至 2024 年" },
        }}
        theme={theme}
      />,
    );
    expect(dataCard).toContain("突触强度");
    expect(dataCard).toContain("来源：CERN 公开资料");
    expect(dataCard).toContain("数据截至 2024 年");

    const keyword = renderToStaticMarkup(
      <ComponentShotVisual
        spec={{
          ...makeComponentSpec("keyword-block", { title: "孤独的神经元" }),
          source: { label: "CERN 公开资料" },
        }}
        theme={theme}
      />,
    );
    expect(keyword).not.toContain("来源：CERN 公开资料");
  });

  test("未知组件与缺失 componentId 渲染占位", () => {
    const unknown = renderToStaticMarkup(
      <ComponentShotVisual
        spec={makeComponentSpec("no-such", { title: "x" })}
        theme={theme}
      />,
    );
    expect(unknown).toContain("尚未实现");

    const missing = renderToStaticMarkup(
      <ComponentShotVisual
        spec={{ ...makeComponentSpec("keyword-block", { title: "x" }), componentId: undefined }}
        theme={theme}
      />,
    );
    expect(missing).toContain("缺少 componentId");
  });
});

describe("ShotsComposition 的 image 视觉层（T204 imageByShot）", () => {
  /** 构造最小 timeline v2（单镜头 1s）。 */
  function makeTimeline(): any {
    return {
      contractVersion: "2.0",
      fps: 30,
      tailPauseMs: 0,
      timingSource: "estimated",
      totalMs: 1000,
      shots: [
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      ],
      cues: [],
    };
  }

  /** 构造 image 镜头 spec。 */
  function makeImageSpec(): ShotSpec {
    return {
      shotId: "sh-001",
      visualType: "image",
      props: {},
      assetRefs: [{ assetId: "asset-db-id", role: "background" }],
      transition: { in: "hard-cut", out: "hard-cut" },
      animations: [],
      source: null,
    };
  }

  test("imageByShot 命中时 img src 用 publicDir 相对路径", async () => {
    const { ShotsComposition } = await import(
      "../../packages/remotion-engine/src/composition"
    );
    const html = renderToStaticMarkup(
      <ShotsComposition
        fps={30}
        theme={makeTheme()}
        timeline={makeTimeline()}
        specShots={[makeImageSpec()]}
        shotIds={null}
        imageByShot={{ "sh-001": "sh-001.png" }}
      />,
    );
    expect(html).toContain('src="sh-001.png"');
  });

  test("无映射时回退 assetRef.assetId 占位，缺 spec 时仅背景色", async () => {
    const { ShotsComposition } = await import(
      "../../packages/remotion-engine/src/composition"
    );
    const fallback = renderToStaticMarkup(
      <ShotsComposition
        fps={30}
        theme={makeTheme()}
        timeline={makeTimeline()}
        specShots={[makeImageSpec()]}
        shotIds={null}
        imageByShot={null}
      />,
    );
    expect(fallback).toContain('src="asset-db-id"');

    const bare = renderToStaticMarkup(
      <ShotsComposition
        fps={30}
        theme={makeTheme()}
        timeline={makeTimeline()}
        specShots={null}
        shotIds={null}
        imageByShot={null}
      />,
    );
    expect(bare).not.toContain("<img");
  });
});
