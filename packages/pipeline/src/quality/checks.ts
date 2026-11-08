import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VideoForgeError,
  DATA_COMPONENT_IDS,
  type CopyDocV2,
  type NarrationCue,
  type QualityCheck,
  type QualityViolation,
  type SceneSpecV2,
  type ThemeV2,
  type TimelineDocV2,
} from "@videoforge/shared";
import { AUDIO_CUES_RELATIVE_PATH, readAudioCues } from "../audio-cues.js";
import { readCopyDocument } from "../copy-contract.js";
import { readSceneSpec } from "../scene-spec-store.js";
import { readThemeSnapshot } from "../theme.js";
import { readTimelineV2 } from "../timeline-v2.js";
import { QUALITY_CHECK_LABELS } from "./report.js";

/**
 * 质检 5 项检查实现（T206，方案 §7.4）。
 * - 每项检查是独立纯函数（除静帧检测外不触外部进程），正反样例可穷举单测；
 * - `runQualityChecks` 组合入口：读项目产物、缺数据源的检查按 skipped 处理；
 * - 本模块只产出 `QualityCheck` 结论，落盘与门禁拦截由 T207 接入引擎时处理。
 */

/** 画面对比度的最低可接受值（方案 §7.4 阈值 7.2:1）。 */
export const CONTRAST_MIN_RATIO = 7.2;

/** 静帧判定：冻结持续超过该毫秒数才报告（方案 §7.4 每 0.25s 采样口径）。 */
export const FREEZE_MIN_DURATION_MS = 250;

/** 静帧检测的噪声阈值（freezedetect n 参数，越低越敏感）。 */
export const FREEZE_NOISE_THRESHOLD = 0.001;

/**
 * 静帧违规的镜头覆盖率阈值：冻结时间占镜头时长的比例达到该值才判违规。
 * 镜头内的短暂静止（动效结束后的稳定显示）是固定动效设计的预期形态；
 * 只有"整镜近乎冻结"才是渲染故障信号（组件未渲染 / 图片加载失败等）。
 */
export const FREEZE_SHOT_COVERAGE_RATIO = 0.8;

/** 需要来源标注的数据展示型组件（方案 §5.6：数据类镜头必须提供来源；清单在 shared 统一定义）。 */

/**
 * 生成检查结论的辅助：按级别映射 pass/fail/warn。
 * @param id 检查项 ID
 * @param blocking 是否阻断型检查（fail 对应阻断，否则 warn）
 * @param violations 违规列表
 * @returns 检查结论
 */
function buildCheck(
  id: keyof typeof QUALITY_CHECK_LABELS,
  blocking: boolean,
  violations: QualityViolation[],
): QualityCheck {
  return {
    id,
    label: QUALITY_CHECK_LABELS[id],
    status: violations.length === 0 ? "pass" : blocking ? "fail" : "warn",
    violations,
  };
}

/**
 * 计算单个 sRGB 颜色通道的相对亮度分量（WCAG 2.x 公式）。
 * @param channel 0-255 通道值
 * @returns 线性化分量
 */
function linearizeChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/**
 * 计算 #RRGGBB 颜色的 WCAG 相对亮度。
 * @param hex 颜色值
 * @returns 相对亮度 0-1
 */
function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (
    0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b)
  );
}

/**
 * 计算两色 WCAG 对比度。
 * @param foreground 前景色 #RRGGBB
 * @param background 背景色 #RRGGBB
 * @returns 对比度（≥1）
 */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 检查 2：字幕溢出（阻断）。
 * 旁白 cue 去空白后的显示长度超过主题 `max_chars_per_line` 即违规——ASS 不自动换行，
 * 超长字幕会溢出画面（T105 的 WrapStyle=2 约定）。
 * @param cues 旁白 cue（audio/cues.json）
 * @param theme 主题（提供单行字数上限）
 * @returns 检查结论
 */
export function checkSubtitleOverflow(cues: NarrationCue[], theme: ThemeV2): QualityCheck {
  const maxChars = theme.tokens.caption.max_chars_per_line;
  const violations = cues
    .filter((cue) => cue.text.replace(/\s/g, "").length > maxChars)
    .map((cue) => ({
      shotId: cue.shotId,
      detail: `字幕 ${cue.cueId} 长 ${cue.text.replace(/\s/g, "").length} 字，超过单行上限 ${maxChars}`,
    }));
  return buildCheck("subtitle-overflow", true, violations);
}

/**
 * 检查 3：来源标签（阻断）。
 * 数据展示型组件镜头必须提供来源：优先取 SceneSpec 的 `source`，回退 copy v2 的
 * `sourceRef`；两处都缺失即违规（来源无法渲染也无法通过质检追溯）。
 * @param copyDoc copy v2（sourceRef 回退来源）
 * @param spec SceneSpec（source 主来源）；scene 未跑时按 copy 判定
 * @returns 检查结论
 */
export function checkSourceLabels(copyDoc: CopyDocV2, spec: SceneSpecV2 | null): QualityCheck {
  const sourceByShot = new Map(
    (spec?.shots ?? []).map((shot) => [shot.shotId, shot.source ?? null]),
  );
  const violations: QualityViolation[] = [];
  for (const scene of copyDoc.scenes) {
    for (const shot of scene.shots) {
      const componentId = shot.component?.id;
      if (!componentId || !DATA_COMPONENT_IDS.has(componentId)) continue;
      const specSource = sourceByShot.get(shot.shotId) ?? null;
      if (!specSource && !shot.sourceRef) {
        violations.push({
          shotId: shot.shotId,
          detail: `数据镜头缺少来源标注（组件 ${componentId}）`,
        });
      }
    }
  }
  return buildCheck("source-label", true, violations);
}

/**
 * 检查 4：画面对比度（警告）。
 * 主题文本色对背景色的 WCAG 对比度低于 7.2:1 即违规；存在次级背景色时一并检查。
 * 资产平均亮度依赖图像解码，暂不纳入（首版只做主题 token 对比度，见任务日志）。
 * @param theme 主题
 * @returns 检查结论
 */
export function checkContrast(theme: ThemeV2): QualityCheck {
  const pairs: Array<{ name: string; foreground: string; background: string }> = [
    { name: "文本/背景", foreground: theme.tokens.text, background: theme.tokens.background },
  ];
  const secondary = theme.tokens.secondary[0];
  if (secondary) {
    pairs.push({ name: "文本/次级背景", foreground: theme.tokens.text, background: secondary });
  }
  const violations: QualityViolation[] = [];
  for (const pair of pairs) {
    const ratio = contrastRatio(pair.foreground, pair.background);
    if (ratio < CONTRAST_MIN_RATIO) {
      violations.push({
        detail: `${pair.name}对比度 ${ratio.toFixed(2)}:1，低于 ${CONTRAST_MIN_RATIO}:1（${pair.foreground} on ${pair.background}）`,
      });
    }
  }
  return buildCheck("contrast", false, violations);
}

/**
 * 检查 5：动效时长（警告）。
 * SceneSpec 动效时长超出主题 [min,max] 即 fail（违反"固定动效"约定）；
 * 触发时刻加时长超出镜头边界即 warn（动效会被镜头切换裁切，不阻断）。
 * @param timeline timeline v2（镜头时长边界）
 * @param spec SceneSpec（动效列表）；scene 未跑时返回 pass
 * @param theme 主题（动效时长边界 token）
 * @returns 检查结论
 */
export function checkAnimationDurations(
  timeline: TimelineDocV2,
  spec: SceneSpecV2 | null,
  theme: ThemeV2,
): QualityCheck {
  if (!spec) {
    return buildCheck("animation-duration", false, []);
  }
  const durationByShot = new Map(timeline.shots.map((shot) => [shot.shotId, shot.durationMs]));
  const { min_duration_ms: minDurationMs, max_duration_ms: maxDurationMs } = theme.motion;
  const violations: QualityViolation[] = [];
  for (const shot of spec.shots) {
    const shotDurationMs = durationByShot.get(shot.shotId);
    for (const animation of shot.animations) {
      if (animation.durationMs < minDurationMs || animation.durationMs > maxDurationMs) {
        violations.push({
          shotId: shot.shotId,
          detail: `动效 ${animation.effect} 时长 ${animation.durationMs}ms 超出 [${minDurationMs}, ${maxDurationMs}]`,
        });
        continue;
      }
      if (shotDurationMs !== undefined && animation.atMs + animation.durationMs > shotDurationMs) {
        violations.push({
          shotId: shot.shotId,
          detail: `动效 ${animation.effect} 在镜头内越界：atMs ${animation.atMs} + ${animation.durationMs}ms > 镜头 ${shotDurationMs}ms`,
        });
      }
    }
  }
  return buildCheck("animation-duration", false, violations);
}

/**
 * 解析 ffmpeg freezedetect 的 stderr 输出为冻结区间（毫秒）。
 * 输出行形如 `freeze_start: 1.25` / `freeze_duration: 2.5`（秒，浮点）。
 * @param stderr ffmpeg 输出
 * @returns 冻结区间列表 { startMs, durationMs }
 */
export function parseFreezeIntervals(stderr: string): Array<{ startMs: number; durationMs: number }> {
  const intervals: Array<{ startMs: number; durationMs: number }> = [];
  let pendingStartMs: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = /freeze_start:\s*([\d.]+)/.exec(line);
    if (startMatch) {
      pendingStartMs = Math.round(Number(startMatch[1]) * 1000);
      continue;
    }
    const durationMatch = /freeze_duration:\s*([\d.]+)/.exec(line);
    if (durationMatch && pendingStartMs !== undefined) {
      intervals.push({
        startMs: pendingStartMs,
        durationMs: Math.round(Number(durationMatch[1]) * 1000),
      });
      pendingStartMs = undefined;
    }
  }
  return intervals;
}

/**
 * 把冻结区间映射到镜头违规：冻结时间覆盖镜头时长 ≥80% 才判违规（镜头内短暂静止
 * 是固定动效设计的预期形态）；`skipShotIds` 中的镜头（如 image 类，整镜静止属预期）
 * 一律不报。
 * @param intervals 冻结区间（相对全片毫秒）
 * @param timeline timeline v2
 * @param skipShotIds 跳过判定的镜头 ID
 * @returns 违规列表
 */
function freezeViolations(
  intervals: Array<{ startMs: number; durationMs: number }>,
  timeline: TimelineDocV2,
  skipShotIds: ReadonlySet<string>,
): QualityViolation[] {
  const violations: QualityViolation[] = [];
  for (const shot of timeline.shots) {
    if (skipShotIds.has(shot.shotId)) continue;
    const overlap = intervals.reduce((sum, interval) => {
      const start = Math.max(interval.startMs, shot.startMs);
      const end = Math.min(interval.startMs + interval.durationMs, shot.endMs);
      return sum + Math.max(0, end - start);
    }, 0);
    if (overlap >= shot.durationMs * FREEZE_SHOT_COVERAGE_RATIO) {
      const coverage = Math.round((overlap / shot.durationMs) * 100);
      violations.push({
        shotId: shot.shotId,
        detail: `镜头 ${shot.shotId} 静帧覆盖率 ${coverage}%（冻结 ${overlap}ms / 镜头 ${shot.durationMs}ms）`,
      });
    }
  }
  return violations;
}

/**
 * 检查 1：静帧检测（警告）。
 * 用 ffmpeg `freezedetect` 过滤器扫描物化帧序列（`-framerate` 按时间轴帧率重放），
 * 冻结时间覆盖镜头 ≥80% 判违规；`skipShotIds`（image 类整镜静止属预期）不参与判定。
 * 检测执行失败时降级为 warn（不阻塞质检流程）。
 * @param options.ffmpegPath ffmpeg 可执行文件
 * @param options.framesPattern 物化帧序列 pattern（如 `build/compose/landscape/frames/%08d.jpeg`）
 * @param options.fps 帧率
 * @param options.timeline timeline v2（冻结区间 → 镜头映射）
 * @param options.logPath ffmpeg 诊断日志输出路径
 * @param options.skipShotIds 跳过判定的镜头 ID；缺省不跳过
 * @returns 检查结论
 */
export async function checkFreeze(options: {
  ffmpegPath: string;
  framesPattern: string;
  fps: number;
  timeline: TimelineDocV2;
  logPath: string;
  skipShotIds?: string[];
}): Promise<QualityCheck> {
  const args = [
    "-y",
    "-framerate",
    String(options.fps),
    "-i",
    options.framesPattern,
    "-vf",
    `freezedetect=n=${FREEZE_NOISE_THRESHOLD}:d=${(FREEZE_MIN_DURATION_MS / 1000).toFixed(2)}`,
    "-f",
    "null",
    "-",
  ];
  let stderr = "";
  let failed: string | undefined;
  await new Promise<void>((resolve) => {
    const child = spawn(options.ffmpegPath, args, { windowsHide: true });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      failed = `ffmpeg 启动失败：${err.message}`;
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) failed = `ffmpeg 退出码 ${code}`;
      resolve();
    });
  });
  mkdirSync(dirname(options.logPath), { recursive: true });
  writeFileSync(options.logPath, stderr, "utf-8");

  if (failed) {
    return {
      id: "freeze",
      label: QUALITY_CHECK_LABELS.freeze,
      status: "warn",
      violations: [{ detail: `静帧检测执行失败（${failed}），诊断见 ${options.logPath}` }],
    };
  }
  const intervals = parseFreezeIntervals(stderr);
  return buildCheck(
    "freeze",
    false,
    freezeViolations(intervals, options.timeline, new Set(options.skipShotIds ?? [])),
  );
}

/**
 * 组合入口：读取项目产物并执行全部可执行的检查。
 * 数据源缺失时对应检查按 skipped 处理（由 buildQualityReport 合并补齐）；
 * copy 非 v2 时抛错——质检 v2 专用，v1 项目不进入质检链路。
 * @param options.projectDir 项目工作目录
 * @param options.framesPattern 可选：物化帧序列 pattern（提供时执行静帧检测）
 * @param options.ffmpegPath 可选：ffmpeg 路径（静帧检测用）
 * @param options.logPath 可选：静帧检测日志路径
 * @param options.skipFreezeShotIds 可选：静帧判定跳过的镜头 ID（image 类整镜静止属预期）
 * @param options.runId 关联 run ID（T207 接入时透传）
 * @returns 5 项检查结论（freeze 为异步结果）
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) copy 非 v2 或 timeline v2 非法
 */
export async function runQualityChecks(options: {
  projectDir: string;
  framesPattern?: string;
  ffmpegPath?: string;
  logPath?: string;
  skipFreezeShotIds?: string[];
  runId?: string;
}): Promise<QualityCheck[]> {
  const document = readCopyDocument(join(options.projectDir, "copy.json"));
  if (document.version !== "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `质检 v2 需要 copy.json v2，当前项目是 v1：${options.projectDir}`,
    );
  }
  const timelinePath = join(options.projectDir, "timeline.json");
  const timeline = existsSync(timelinePath) ? readTimelineV2(timelinePath) : null;
  const themeSnapshot = readThemeSnapshot(options.projectDir);
  const spec = readSceneSpec(options.projectDir);
  const cuesPath = join(options.projectDir, AUDIO_CUES_RELATIVE_PATH);
  const cues = existsSync(cuesPath) ? readAudioCues(cuesPath).cues : [];

  const checks: QualityCheck[] = [];
  // 1) 静帧：需要物化帧与 ffmpeg；缺输入时由调用方（T207）决定 skipped 语义
  if (options.framesPattern && options.ffmpegPath && timeline) {
    checks.push(
      await checkFreeze({
        ffmpegPath: options.ffmpegPath,
        framesPattern: options.framesPattern,
        fps: timeline.fps,
        timeline,
        logPath: options.logPath ?? join(options.projectDir, "quality", "freeze.log"),
        skipShotIds: options.skipFreezeShotIds,
      }),
    );
  }
  // 2) 字幕溢出：需要 cue 与主题
  if (cues.length > 0 && themeSnapshot) {
    checks.push(checkSubtitleOverflow(cues as NarrationCue[], themeSnapshot.theme));
  }
  // 3) 来源标签：copy 必有
  checks.push(checkSourceLabels(document.doc, spec));
  // 4) 对比度：需要主题
  if (themeSnapshot) {
    checks.push(checkContrast(themeSnapshot.theme));
  }
  // 5) 动效时长：需要 spec、timeline 与主题
  if (spec && timeline && themeSnapshot) {
    checks.push(checkAnimationDurations(timeline, spec, themeSnapshot.theme));
  }
  return checks;
}
