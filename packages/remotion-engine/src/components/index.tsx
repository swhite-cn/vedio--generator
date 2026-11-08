import { DATA_COMPONENT_IDS, type ShotSpec } from "@videoforge/shared";
import type { RemotionTheme } from "../theme.js";
import { ChapterBadge, type ChapterBadgeProps } from "./chapter-badge.js";
import { ComparisonBars, type ComparisonBarsProps } from "./comparison-bars.js";
import { DataCard, type DataCardProps } from "./data-card.js";
import { KeywordBlock, type KeywordBlockProps } from "./keyword-block.js";
import { ProgressRing, type ProgressRingProps } from "./progress-ring.js";
import { QuoteCard, type QuoteCardProps } from "./quote-card.js";
import { SourceTag, type SourceTagProps } from "./source-tag.js";

/**
 * 组件镜头视觉分发（T202 三类 + T203 四类）。
 * - 按 `componentId` 把 SceneSpec 的组件镜头分发到 React 实现；
 * - 参数校验只发生在装配期（`assembleComponentShot` 的注册表强校验，方案 §5.6）；
 *   渲染层不重复校验，因此不引入注册表的 node 依赖（浏览器 bundle 安全）；
 * - 未知组件/缺失 ID 渲染占位层，不抛错——渲染失败应定位到镜头而不是白屏。
 */

/** componentId → React 实现；7 类组件全部登记（T109 三类 + T203 四类）。 */
const COMPONENT_RENDERERS: Record<
  string,
  (input: { props: Record<string, unknown>; theme: RemotionTheme }) => React.ReactElement
> = {
  "keyword-block": ({ props, theme }) => (
    <KeywordBlock props={props as unknown as KeywordBlockProps} theme={theme} />
  ),
  "data-card": ({ props, theme }) => (
    <DataCard props={props as unknown as DataCardProps} theme={theme} />
  ),
  "quote-card": ({ props, theme }) => (
    <QuoteCard props={props as unknown as QuoteCardProps} theme={theme} />
  ),
  "comparison-bars": ({ props, theme }) => (
    <ComparisonBars props={props as unknown as ComparisonBarsProps} theme={theme} />
  ),
  "progress-ring": ({ props, theme }) => (
    <ProgressRing props={props as unknown as ProgressRingProps} theme={theme} />
  ),
  "chapter-badge": ({ props, theme }) => (
    <ChapterBadge props={props as unknown as ChapterBadgeProps} theme={theme} />
  ),
  "source-tag": ({ props, theme }) => (
    <SourceTag props={props as unknown as SourceTagProps} theme={theme} />
  ),
};

/**
 * 组件镜头渲染入口（composition 内按 visualType=component 调用）。
 * @param spec 组件镜头规格（componentId + props，参数合法性由装配期保证）
 * @param theme 渲染主题常量
 * @returns React 元素（未知组件渲染占位）
 */
export function ComponentShotVisual({
  spec,
  theme,
}: {
  spec: ShotSpec;
  theme: RemotionTheme;
}) {
  const shellStyle: React.CSSProperties = {
    backgroundColor: theme.background,
    color: theme.color,
    fontFamily: theme.fontFamily,
    padding: theme.safePaddingPx,
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: theme.bodySizePx * 0.4,
  };

  if (!spec.componentId) {
    return (
      <div style={shellStyle}>
        <div style={{ fontSize: theme.bodySizePx, opacity: 0.6 }}>
          组件镜头缺少 componentId
        </div>
      </div>
    );
  }

  const renderer = COMPONENT_RENDERERS[spec.componentId];
  if (!renderer) {
    return (
      <div style={shellStyle}>
        <div style={{ fontSize: theme.bodySizePx, opacity: 0.6 }}>
          组件 {spec.componentId} 尚未实现（T203）
        </div>
      </div>
    );
  }
  const visual = renderer({ props: spec.props, theme });
  // 数据展示组件必须带来源：组件层叠加来源标签（T402，视觉出口与质检共用同一清单）
  const needsSource = DATA_COMPONENT_IDS.has(spec.componentId) && Boolean(spec.source?.label);
  if (!needsSource || !spec.source) return visual;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {visual}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <SourceTag props={{ label: spec.source.label, note: spec.source.note }} theme={theme} />
      </div>
    </div>
  );
}
