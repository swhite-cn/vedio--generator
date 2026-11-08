import type { RemotionTheme } from "../theme.js";
import { useEntranceProgress } from "./common.js";

/** 来源标签参数（对齐注册表 source-tag.paramsSchema，T203）。 */
export interface SourceTagProps {
  /** 来源展示文案，≤20 字。 */
  label: string;
  /** 补充说明（如「数据截至 2024 年」），≤40 字。 */
  note?: string;
}

/**
 * 来源标签组件（方案 §5.6 source 类，质检"来源标签"检查的视觉出口）。
 * 画面底部小字标注：来源 + 可选补充说明；入场淡入。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function SourceTag({ props, theme }: { props: SourceTagProps; theme: RemotionTheme }) {
  const progress = useEntranceProgress(theme);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: theme.safePaddingPx,
        opacity: progress,
        fontFamily: theme.fontFamily,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: theme.captionSizePx * 0.5,
          fontSize: theme.captionSizePx,
          color: theme.color,
          opacity: 0.82,
        }}
      >
        <span
          style={{
            width: Math.round(theme.captionSizePx * 0.45),
            height: Math.round(theme.captionSizePx * 0.45),
            borderRadius: "50%",
            backgroundColor: theme.accent,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span>来源：{props.label}</span>
        {props.note ? <span style={{ opacity: 0.75 }}>{props.note}</span> : null}
      </div>
    </div>
  );
}
