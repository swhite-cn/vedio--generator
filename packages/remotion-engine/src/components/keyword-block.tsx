import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 关键词块参数（对齐注册表 keyword-block.paramsSchema，T109）。 */
export interface KeywordBlockProps {
  /** 屏上主标题，≤18 字。 */
  title: string;
  /** 副标题，≤28 字。 */
  subtitle?: string;
  /** 强调下划线动效。 */
  underline?: "none" | "sweep" | "grow";
}

/**
 * 关键词块组件（方案 §5.6 text 类，参考片占比 28%）。
 * 主标题大字 + 可选下划线强调 + 可选副标题；入场淡入上移。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function KeywordBlock({
  props,
  theme,
}: {
  props: KeywordBlockProps;
  theme: RemotionTheme;
}) {
  const progress = useEntranceProgress(theme);
  const underlineWidth =
    props.underline === "sweep"
      ? `${Math.round(progress * 100)}%`
      : props.underline === "grow"
        ? `${Math.max(24, Math.round(progress * 100))}%`
        : "0%";

  return (
    <div
      style={{
        ...componentShellStyle(theme),
        opacity: progress,
        transform: `translateY(${(1 - progress) * 24}px)`,
      }}
    >
      <div
        style={{
          fontSize: theme.titleSizePx,
          fontWeight: 700,
          lineHeight: 1.15,
          letterSpacing: "0.02em",
        }}
      >
        {props.title}
      </div>
      <div
        style={{
          width: underlineWidth,
          height: Math.max(6, Math.round(theme.titleSizePx * 0.08)),
          backgroundColor: theme.accent,
          borderRadius: theme.titleSizePx * 0.04,
        }}
      />
      {props.subtitle ? (
        <div style={{ fontSize: theme.bodySizePx, opacity: 0.72 }}>{props.subtitle}</div>
      ) : null}
    </div>
  );
}
