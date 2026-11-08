import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  QUALITY_REPORT_RELATIVE_PATH,
  buildQualityReport,
  readCopyDocument,
  runQualityChecks,
  summarizeQualityReport,
  writeQualityReport,
  type QualitySummary,
} from "@videoforge/pipeline";
import type { QualityReport } from "@videoforge/shared";

/**
 * 质检门禁（T207，方案 §7.4）：compose 完成后由工作流引擎钩子调用。
 * 职责：组装质检输入（物化帧 pattern、静帧跳过镜头）→ 执行 5 项检查 →
 * 报告落盘（quality/report.json，追加式覆盖写最新结论）→ 返回报告与汇总。
 * 本模块不决定 run 的成败（门禁拦截留 T404）；质检失败向上抛错由调用方收口。
 */

/** v2 质检门禁执行结果。 */
export interface QualityGateResult {
  /** 已落盘的最新报告。 */
  report: QualityReport;
  /** 汇总（fail/warn/skipped 计数与阻断判断）。 */
  summary: QualitySummary;
}

/**
 * 从项目 Profile 目录名推导 build 下的画面子目录（与渲染/合成层约定一致）。
 * @param profile Profile 目录名（如 landscape-1080p）
 * @returns `landscape` 或 `portrait`
 */
function profileDirOf(profile: string): string {
  return profile.startsWith("portrait") ? "portrait" : "landscape";
}

/**
 * 执行质检门禁并落盘报告。
 * - 静帧检测仅在物化帧目录存在时执行（compose 产物）；image 类镜头（整镜静止属预期）
 *   从静帧判定中剔除；
 * - 报告以 `runId` 关联本次 run，写 `quality/report.json`；
 * - 检查抛错向上传播（调用方决定是否影响 run）。
 * @param options.projectDir 项目工作目录
 * @param options.runId 关联 run ID
 * @param options.profile 项目 Profile 目录名（决定物化帧目录）
 * @param options.ffmpegPath ffmpeg 可执行文件（静帧检测）
 * @returns 报告与汇总
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) copy 非 v2 或产物结构非法
 */
export async function runQualityGate(options: {
  projectDir: string;
  runId: string;
  profile: string;
  ffmpegPath: string;
}): Promise<QualityGateResult> {
  // 静帧跳过口径：copy v2 中 visualType=image 的镜头（无动效设计，整镜静止属预期）
  const document = readCopyDocument(join(options.projectDir, "copy.json"));
  const skipFreezeShotIds =
    document.version === "2"
      ? document.doc.scenes
          .flatMap((scene) => scene.shots)
          .filter((shot) => shot.visualType === "image")
          .map((shot) => shot.shotId)
      : [];

  const framesDir = join(
    options.projectDir,
    "build",
    "compose",
    profileDirOf(options.profile),
    "frames",
  );
  const checks = await runQualityChecks({
    projectDir: options.projectDir,
    framesPattern: existsSync(framesDir) ? join(framesDir, "%08d.jpeg") : undefined,
    ffmpegPath: options.ffmpegPath,
    logPath: join(options.projectDir, "quality", "freeze.log"),
    skipFreezeShotIds,
    runId: options.runId,
  });

  const report = buildQualityReport({ runId: options.runId, checks });
  writeQualityReport(join(options.projectDir, QUALITY_REPORT_RELATIVE_PATH), report);
  return { report, summary: summarizeQualityReport(report) };
}
