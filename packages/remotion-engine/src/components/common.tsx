import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { RemotionTheme } from "../theme.js";

/**
 * 组件共用动效与排版工具（T202）。
 * 动效口径（方案 §5.3）：固定时长、不随镜头拉伸；时长在主题边界内取值。
 */

/** 组件默认动效时长（毫秒），落在主题边界内。 */
export const DEFAULT_ENTRANCE_MS = 400;

/**
 * 入场动效进度（纯函数，便于单测）：0..1，时长夹在主题边界内。
 * @param frame 当前帧号
 * @param fps 帧率
 * @param theme 渲染主题常量
 * @param durationMs 期望动效毫秒（越界自动夹取）
 * @returns 0..1 进度
 */
export function entranceProgress(
  frame: number,
  fps: number,
  theme: RemotionTheme,
  durationMs: number = DEFAULT_ENTRANCE_MS,
): number {
  const clampedMs = Math.min(
    Math.max(durationMs, theme.motion.minDurationMs),
    theme.motion.maxDurationMs,
  );
  const durationFrames = Math.max(1, Math.round(clampedMs / (1000 / fps)));
  return interpolate(frame, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * 组件入场动效 hook：读取当前帧与帧率并换算入场进度。
 * @param theme 渲染主题常量
 * @param durationMs 期望动效毫秒
 * @returns 0..1 进度
 */
export function useEntranceProgress(
  theme: RemotionTheme,
  durationMs: number = DEFAULT_ENTRANCE_MS,
): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return entranceProgress(frame, fps, theme, durationMs);
}

/**
 * 组件根容器统一样式：背景 + 安全区 + 字体族。
 * @param theme 渲染主题常量
 * @returns CSSProperties
 */
export function componentShellStyle(theme: RemotionTheme): React.CSSProperties {
  return {
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
}
