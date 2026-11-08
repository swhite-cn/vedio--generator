import { z } from "zod";

/** #RRGGBB 颜色校验。 */
const hexColorSchema = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "必须是 #RRGGBB");

/**
 * 主题 token：配色、字体、安全区、字幕样式与动效边界。
 * 与输出 Profile 解耦：Profile 管分辨率，主题管视觉语言。
 */
export const themeSchema = z
  .object({
    // 主题唯一 ID，与 config/themes/<id>/ 目录同名
    id: z.string().trim().min(1),
    // 面向用户的主题名
    name: z.string().trim().min(1),
    // 画面规格
    frame: z.object({
      // 设计宽度
      width: z.number().int().positive(),
      // 设计高度
      height: z.number().int().positive(),
      // 安全区比例，0–1
      safe_area: z.number().min(0).max(1),
    }),
    // 视觉 token
    tokens: z.object({
      // 成片文字色
      text: hexColorSchema,
      // 成片背景色
      background: hexColorSchema,
      // 强调色（下划线、数字高亮）
      accent: hexColorSchema,
      // 辅助色板
      secondary: z.array(hexColorSchema).default([]),
      // 字体族
      font_family: z.string().trim().min(1),
      // 标题字号（设计像素）
      title_size: z.number().positive(),
      // 正文字号（设计像素）
      body_size: z.number().positive(),
      // 字幕样式
      caption: z.object({
        // 字号
        size: z.number().positive(),
        // 描边宽度
        stroke: z.number().nonnegative(),
        // 距底边比例，0–1
        bottom_ratio: z.number().min(0).max(1),
        // 单行最大字数；超过触发字幕溢出质检
        max_chars_per_line: z.number().int().positive(),
      }),
    }),
    // 动效边界
    motion: z.object({
      // 最短动效毫秒
      min_duration_ms: z.number().int().min(300).max(800),
      // 最长动效毫秒
      max_duration_ms: z.number().int().min(300).max(800),
    }),
  })
  .refine((theme) => theme.motion.min_duration_ms <= theme.motion.max_duration_ms, {
    message: "motion.min_duration_ms 不能大于 max_duration_ms",
    path: ["motion", "min_duration_ms"],
  });

/** 主题类型。 */
export type ThemeV2 = z.infer<typeof themeSchema>;
