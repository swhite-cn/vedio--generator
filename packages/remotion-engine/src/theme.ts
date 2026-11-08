import type { ThemeV2 } from "@videoforge/shared";

/**
 * 主题 → Remotion 渲染常量（T201）。
 * 主题快照（theme.resolved.json）是唯一视觉语言来源；本模块只做 token 映射，
 * 不引入魔法值、不做组件决策（组件实现在 T202/T203）。
 */

/** Remotion 层可直接使用的主题常量。 */
export interface RemotionTheme {
  /** 主题 ID（透传，用于 trace/日志定位）。 */
  id: string;
  /** 画面宽度（设计像素）。 */
  width: number;
  /** 画面高度（设计像素）。 */
  height: number;
  /** 安全区内边距（像素）= min(width,height) * safe_area。 */
  safePaddingPx: number;
  /** 成片文字色（#RRGGBB）。 */
  color: string;
  /** 成片背景色（#RRGGBB）。 */
  background: string;
  /** 强调色（#RRGGBB）。 */
  accent: string;
  /** 字体族（直接作为 font-family）。 */
  fontFamily: string;
  /** 标题字号（设计像素）。 */
  titleSizePx: number;
  /** 正文字号（设计像素）。 */
  bodySizePx: number;
  /** 字幕字号（设计像素）。 */
  captionSizePx: number;
  /** 字幕单行最大字数（质检口径，渲染层只透传）。 */
  captionMaxCharsPerLine: number;
  /** 动效毫秒边界（300–800）。 */
  motion: { minDurationMs: number; maxDurationMs: number };
}

/**
 * 把 v2 主题解析为 Remotion 常量。
 * @param theme 已校验的主题（来自 loadTheme 或项目快照）
 * @returns 渲染常量
 */
export function resolveRemotionTheme(theme: ThemeV2): RemotionTheme {
  return {
    id: theme.id,
    width: theme.frame.width,
    height: theme.frame.height,
    safePaddingPx: Math.round(
      Math.min(theme.frame.width, theme.frame.height) * theme.frame.safe_area,
    ),
    color: theme.tokens.text,
    background: theme.tokens.background,
    accent: theme.tokens.accent,
    fontFamily: theme.tokens.font_family,
    titleSizePx: theme.tokens.title_size,
    bodySizePx: theme.tokens.body_size,
    captionSizePx: theme.tokens.caption.size,
    captionMaxCharsPerLine: theme.tokens.caption.max_chars_per_line,
    motion: {
      minDurationMs: theme.motion.min_duration_ms,
      maxDurationMs: theme.motion.max_duration_ms,
    },
  };
}
