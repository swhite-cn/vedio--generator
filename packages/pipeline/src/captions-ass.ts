import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VideoForgeError, type NarrationCue, type ThemeV2 } from "@videoforge/shared";
import { AUDIO_CUES_RELATIVE_PATH, readAudioCues } from "./audio-cues.js";
import { readThemeSnapshot } from "./theme.js";

/**
 * captions 阶段：把 `audio/cues.json` 的旁白 cue 生成为独立 ASS 字幕轨。
 * - 一条 cue 对应一条 `Dialogue`，时间与文本严格来自 cue，不做二次断句；
 * - 字号/描边/底部距离/单行字数上限全部来自主题 token（`theme.resolved.json`）；
 * - 产物 `captions/subtitle.ass` 独立于画面，便于关闭字幕、审计与重跑。
 */

/** 字幕轨相对项目目录的路径（POSIX `/`）。 */
export const CAPTIONS_RELATIVE_PATH = "captions/subtitle.ass";

/** 字幕样式名（ASS 内固定 `Default`，样式参数由主题决定）。 */
const ASS_STYLE_NAME = "Default";

/** 字幕默认标题（仅用于 ASS Script Info，不影响成片）。 */
const ASS_TITLE = "VideoForge 字幕轨";

/** 生成字幕轨的入参。 */
export interface GenerateCaptionsInput {
  /** 项目工作目录（读取 audio/cues.json 与 theme.resolved.json）。 */
  projectDir: string;
  /** 主题覆盖（测试或渲染侧已解析主题时传入）；缺省读取项目快照。 */
  theme?: ThemeV2;
}

/** 字幕轨生成结果。 */
export interface GenerateCaptionsResult {
  /** 产物绝对路径。 */
  outPath: string;
  /** 写入的字幕条数（等于 cue 条数）。 */
  cueCount: number;
  /** 覆盖的镜头数。 */
  shotCount: number;
  /** 生效主题 ID。 */
  themeId: string;
}

/**
 * 把 #RRGGBB 转成 ASS 颜色（`&HAABBGGRR`，alpha 固定 00 不透明）。
 * @param hex #RRGGBB 颜色
 * @returns ASS 颜色字面量
 */
function toAssColor(hex: string): string {
  const r = hex.slice(1, 3).toUpperCase();
  const g = hex.slice(3, 5).toUpperCase();
  const b = hex.slice(5, 7).toUpperCase();
  return `&H00${b}${g}${r}`;
}

/**
 * 把毫秒时间转成 ASS 时间（`H:MM:SS.cc`，厘秒精度）。
 * @param ms 毫秒（非负）
 * @returns ASS 时间字符串
 */
export function formatAssTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(cs, 2)}`;
}

/**
 * 清洗字幕文本：去掉 ASS 覆盖标签花括号、把换行改为 `\N`，避免破坏事件行。
 * @param text cue 文本
 * @returns 可写入 ASS 的文本
 */
function sanitizeAssText(text: string): string {
  return text
    .replace(/\r?\n/g, "\\N")
    .replace(/\{/g, "（")
    .replace(/\}/g, "）")
    .trim();
}

/**
 * 取主题字体族中的首个可用字体名（ASS 的 Fontname 只能是单一字体）。
 * @param fontFamily 主题字体族（逗号分隔的 CSS 栈）
 * @returns 首个字体名
 */
function primaryFontName(fontFamily: string): string {
  return fontFamily.replace(/["']/g, "").split(",")[0]?.trim() || "Microsoft YaHei";
}

/**
 * 生成完整 ASS 字幕文件内容：每条 cue 一条 Dialogue，样式来自主题 token。
 * @param cues 旁白 cue（按全片时间）
 * @param theme 主题
 * @param title 可选 ASS 标题
 * @returns ASS 文件文本
 */
export function buildAssSubtitle(cues: NarrationCue[], theme: ThemeV2, title = ASS_TITLE): string {
  const { width, height, safe_area: safeArea } = theme.frame;
  const caption = theme.tokens.caption;
  const marginH = Math.round((width * (1 - safeArea)) / 2);
  const marginV = Math.round(height * caption.bottom_ratio);
  const styleLine = [
    "Style: " + ASS_STYLE_NAME,
    primaryFontName(theme.tokens.font_family),
    String(caption.size),
    toAssColor(theme.tokens.text),
    toAssColor(theme.tokens.accent),
    "&H00000000",
    "&H00000000",
    "0",
    "0",
    "0",
    "0",
    "100",
    "100",
    "0",
    "0",
    "1",
    String(caption.stroke),
    "0",
    "2",
    String(marginH),
    String(marginH),
    String(marginV),
    "1",
  ].join(",");

  const events = cues
    .filter((cue) => sanitizeAssText(cue.text).length > 0)
    .map(
      (cue) =>
        `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${ASS_STYLE_NAME},,0,0,0,,${sanitizeAssText(cue.text)}`,
    );

  return [
    "[Script Info]",
    `; ${title}（由 captions 阶段生成，请勿手改）`,
    `Title: ${title}`,
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
  ].join("\n");
}

/**
 * 统计 ASS 文件中的 Dialogue 条数（供产物判据与质检核对）。
 * @param content ASS 文件文本
 * @returns `Dialogue:` 开头的行数
 */
export function countAssDialogueEvents(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:")).length;
}

/**
 * 读取项目 cue 与主题快照，生成 `captions/subtitle.ass`。
 * @param input 项目目录与可选主题覆盖
 * @returns 产物路径、字幕条数与覆盖镜头数
 * @throws VideoForgeError(`CONFIG_INVALID`) cue 缺失或主题快照缺失时
 */
export function generateCaptions(input: GenerateCaptionsInput): GenerateCaptionsResult {
  const cuesPath = join(input.projectDir, AUDIO_CUES_RELATIVE_PATH);
  if (!existsSync(cuesPath)) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `没有可用的音频 cue（${AUDIO_CUES_RELATIVE_PATH}）；请先运行 tts_generate`,
    );
  }
  const cuesDoc = readAudioCues(cuesPath);
  if (cuesDoc.cues.length === 0) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "audio/cues.json 中没有旁白 cue；请先运行 tts_generate",
    );
  }

  const theme = input.theme ?? readThemeSnapshot(input.projectDir)?.theme;
  if (!theme) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "项目缺少主题快照 theme.resolved.json；请重新解析项目主题",
    );
  }

  const content = buildAssSubtitle(cuesDoc.cues, theme);
  const outPath = join(input.projectDir, CAPTIONS_RELATIVE_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf-8");

  return {
    outPath,
    cueCount: countAssDialogueEvents(content),
    shotCount: cuesDoc.shots.length,
    themeId: theme.id,
  };
}
