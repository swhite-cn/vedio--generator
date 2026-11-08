import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 章节角标参数（对齐注册表 chapter-badge.paramsSchema，T203）。 */
export interface ChapterBadgeProps {
  /** 章节号（如 02），≤6 字。 */
  chapter: string;
  /** 章节标题，≤16 字。 */
  title: string;
  /** 章节副题，≤24 字。 */
  subtitle?: string;
}

/**
 * 章节角标组件（方案 §5.6 chapter 类）。
 * 左侧 accent 竖线 + 大号章节号 + 标题/副题；入场淡入左移。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function ChapterBadge({ props, theme }: { props: ChapterBadgeProps; theme: RemotionTheme }) {
  const progress = useEntranceProgress(theme);

  return (
    <div
      style={{
        ...componentShellStyle(theme),
        opacity: progress,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.bodySizePx * 0.7,
        transform: `translateX(${(1 - progress) * -32}px)`,
      }}
    >
      <div
        style={{
          width: Math.max(8, Math.round(theme.titleSizePx * 0.09)),
          alignSelf: "stretch",
          backgroundColor: theme.accent,
          borderRadius: theme.titleSizePx * 0.05,
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: theme.bodySizePx * 0.25 }}>
        <div
          style={{
            fontSize: Math.round(theme.titleSizePx * 0.6),
            fontWeight: 700,
            color: theme.accent,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {props.chapter}
        </div>
        <div style={{ fontSize: theme.titleSizePx, fontWeight: 700, lineHeight: 1.2 }}>
          {props.title}
        </div>
        {props.subtitle ? (
          <div style={{ fontSize: theme.bodySizePx, opacity: 0.72 }}>{props.subtitle}</div>
        ) : null}
      </div>
    </div>
  );
}
