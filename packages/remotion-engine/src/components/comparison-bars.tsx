import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 对比条参数（对齐注册表 comparison-bars.paramsSchema，T203）。 */
export interface ComparisonBarsProps {
  /** A 组名称，≤12 字。 */
  labelA: string;
  /** A 组数值文本，≤12 字。 */
  valueA: string;
  /** B 组名称，≤12 字。 */
  labelB: string;
  /** B 组数值文本，≤12 字。 */
  valueB: string;
  /** 单位，≤6 字。 */
  unit?: string;
  /** 对比口径说明，≤20 字。 */
  caption?: string;
}

/**
 * 解析数值文本为非负数；无法解析返回 0。
 * @param value 数值文本（可含单位/千分位）
 * @returns 非负数值
 */
function parseNonNegative(value: string): number {
  const parsed = Number.parseFloat(value.replace(/[,，\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 对比条组件（方案 §5.6 compare 类）。
 * 两组横向条形按数值比例生长（动效进度驱动），较大值满宽、较小值按比例；
 * 数值不可解析时两条等宽。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function ComparisonBars({
  props,
  theme,
}: {
  props: ComparisonBarsProps;
  theme: RemotionTheme;
}) {
  const progress = useEntranceProgress(theme);
  const valueA = parseNonNegative(props.valueA);
  const valueB = parseNonNegative(props.valueB);
  const maxValue = Math.max(valueA, valueB);
  const ratio = (value: number): number =>
    maxValue > 0 ? value / maxValue : 0.5;
  const rows = [
    { label: props.labelA, value: props.valueA, fraction: ratio(valueA) },
    { label: props.labelB, value: props.valueB, fraction: ratio(valueB) },
  ];

  return (
    <div
      style={{
        ...componentShellStyle(theme),
        opacity: progress,
        justifyContent: "center",
        gap: theme.bodySizePx * 0.55,
      }}
    >
      {rows.map((row) => (
        <div key={row.label} style={{ display: "flex", flexDirection: "column", gap: theme.bodySizePx * 0.2 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: theme.bodySizePx, opacity: 0.85 }}>{row.label}</span>
            <span style={{ fontSize: theme.bodySizePx, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {row.value}
              {props.unit ? <span style={{ opacity: 0.7, fontWeight: 400 }}> {props.unit}</span> : null}
            </span>
          </div>
          <div
            style={{
              height: Math.max(14, Math.round(theme.bodySizePx * 0.45)),
              width: "100%",
              backgroundColor: `${theme.accent}26`,
              borderRadius: theme.bodySizePx * 0.25,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round(row.fraction * progress * 100)}%`,
                backgroundColor: theme.accent,
                borderRadius: theme.bodySizePx * 0.25,
              }}
            />
          </div>
        </div>
      ))}
      {props.caption ? (
        <div style={{ fontSize: theme.captionSizePx, opacity: 0.6 }}>{props.caption}</div>
      ) : null}
    </div>
  );
}
