import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 进度环参数（对齐注册表 progress-ring.paramsSchema，T203）。 */
export interface ProgressRingProps {
  /** 指标名，≤12 字。 */
  label: string;
  /** 百分比 0–100。 */
  percent: number;
  /** 数值单位文本，≤6 字（缺省显示 %）。 */
  unit?: string;
  /** 口径说明，≤20 字。 */
  caption?: string;
}

/**
 * 进度环组件（方案 §5.6 progress 类）。
 * SVG 圆环按百分比填充（动效进度驱动弧长），中心显示百分比数值。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function ProgressRing({ props, theme }: { props: ProgressRingProps; theme: RemotionTheme }) {
  const progress = useEntranceProgress(theme);
  // 圆环几何：viewBox 200×200，半径 84，线宽 18
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(props.percent, 0), 100);
  const filled = circumference * (clamped / 100) * progress;

  return (
    <div
      style={{
        ...componentShellStyle(theme),
        opacity: progress,
        alignItems: "center",
        textAlign: "center",
        gap: theme.bodySizePx * 0.4,
      }}
    >
      <div style={{ fontSize: theme.bodySizePx, opacity: 0.85, letterSpacing: "0.08em" }}>
        {props.label}
      </div>
      <svg width={340} height={340} viewBox="0 0 200 200" role="img" aria-label={`${props.label} ${clamped}%`}>
        <circle
          cx={100}
          cy={100}
          r={radius}
          fill="none"
          stroke={`${theme.accent}33`}
          strokeWidth={18}
        />
        <circle
          cx={100}
          cy={100}
          r={radius}
          fill="none"
          stroke={theme.accent}
          strokeWidth={18}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 100 100)"
        />
        <text
          x={100}
          y={100}
          textAnchor="middle"
          dominantBaseline="central"
          fill={theme.color}
          fontSize={44}
          fontWeight={700}
          fontFamily={theme.fontFamily}
        >
          {clamped}
          {props.unit ?? "%"}
        </text>
      </svg>
      {props.caption ? (
        <div style={{ fontSize: theme.captionSizePx, opacity: 0.6 }}>{props.caption}</div>
      ) : null}
    </div>
  );
}
