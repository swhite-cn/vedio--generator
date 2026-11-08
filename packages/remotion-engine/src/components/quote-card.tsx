import type { RemotionTheme } from "../theme.js";
import { componentShellStyle, useEntranceProgress } from "./common.js";

/** 引语卡参数（对齐注册表 quote-card.paramsSchema，T109）。 */
export interface QuoteCardProps {
  /** 引语正文，≤48 字。 */
  quote: string;
  /** 引语主体，≤20 字。 */
  author?: string;
  /** 身份/出处，≤24 字。 */
  role?: string;
  /** 需要高亮的词，≤12 字。 */
  emphasis?: string;
}

/**
 * 引语卡组件（方案 §5.6 quote 类）。
 * 引号装饰 + 正文（emphasis 词高亮）+ 落款；入场淡入。
 * @param props 组件参数
 * @param theme 渲染主题常量
 * @returns React 元素
 */
export function QuoteCard({ props, theme }: { props: QuoteCardProps; theme: RemotionTheme }) {
  const progress = useEntranceProgress(theme);
  // emphasis 高亮：按首次出现位置切分正文；未命中则整段原样
  const segments = props.emphasis
    ? (() => {
        const index = props.quote.indexOf(props.emphasis);
        if (index < 0) return null;
        return [
          props.quote.slice(0, index),
          props.quote.slice(index, index + props.emphasis.length),
          props.quote.slice(index + props.emphasis.length),
        ];
      })()
    : null;

  return (
    <div
      style={{
        ...componentShellStyle(theme),
        opacity: progress,
        gap: theme.bodySizePx * 0.6,
      }}
    >
      <div
        style={{
          fontSize: theme.titleSizePx,
          color: theme.accent,
          lineHeight: 0.8,
          fontFamily: "Georgia, serif",
        }}
      >
        “
      </div>
      <div style={{ fontSize: Math.round(theme.bodySizePx * 1.35), lineHeight: 1.5 }}>
        {segments ? (
          <>
            {segments[0]}
            <span style={{ color: theme.accent, fontWeight: 700 }}>{segments[1]}</span>
            {segments[2]}
          </>
        ) : (
          props.quote
        )}
      </div>
      {props.author ? (
        <div style={{ fontSize: theme.bodySizePx, opacity: 0.75 }}>
          —— {props.author}
          {props.role ? `（${props.role}）` : ""}
        </div>
      ) : null}
    </div>
  );
}
