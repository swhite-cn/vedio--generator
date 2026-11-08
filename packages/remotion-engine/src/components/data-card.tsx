import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 数据卡参数（对齐注册表 data-card.paramsSchema，T109）。 */
export interface DataCardProps {
  /** 指标名，≤12 字。 */
  label: string;
  /** 数值文本（含千分位/小数），≤12 字。 */
  value: string;
  /** 单位，≤6 字。 */
  unit?: string;
  /** 统计口径/时间范围，≤20 字。 */
  caption?: string;
  /** 趋势箭头。 */
  trend?: "up" | "down" | "flat";
}

/**
 * 数据卡组件（方案 §5.6 data 类）。
 * 指标名 + 大号数值（accent 强调）+ 单位 + 口径说明 + 可选趋势箭头；入场淡入上移。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function DataCard({ props, theme }: { props: DataCardProps; theme: RemotionTheme }) {
  const progress = useEntranceProgress(theme);
  const trendMark = props.trend === "up" ? "↑" : props.trend === "down" ? "↓" : props.trend === "flat" ? "→" : null;

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
          fontSize: theme.bodySizePx,
          letterSpacing: "0.12em",
          opacity: 0.72,
        }}
      >
        {props.label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: theme.bodySizePx * 0.25 }}>
        <span
          style={{
            fontSize: theme.titleSizePx,
            fontWeight: 700,
            color: theme.accent,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {props.value}
        </span>
        {props.unit ? (
          <span style={{ fontSize: theme.bodySizePx, opacity: 0.85 }}>{props.unit}</span>
        ) : null}
        {trendMark ? (
          <span style={{ fontSize: theme.bodySizePx, color: theme.accent }}>{trendMark}</span>
        ) : null}
      </div>
      {props.caption ? (
        <div style={{ fontSize: theme.captionSizePx, opacity: 0.6 }}>{props.caption}</div>
      ) : null}
    </div>
  );
}
