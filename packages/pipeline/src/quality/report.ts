import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  QUALITY_CHECK_IDS,
  VideoForgeError,
  qualityReportSchema,
  type QualityCheck,
  type QualityCheckId,
  type QualityReport,
  type QualityStatus,
} from "@videoforge/shared";

/** 质检报告相对项目目录的固定路径（POSIX 分隔符，供能力判据与读取器共用）。 */
export const QUALITY_REPORT_RELATIVE_PATH = "quality/report.json";

/** 5 个固定检查项的中文展示名，顺序与 `QUALITY_CHECK_IDS` 一致。 */
export const QUALITY_CHECK_LABELS: Readonly<Record<QualityCheckId, string>> = {
  freeze: "静帧检测",
  "subtitle-overflow": "字幕溢出",
  "source-label": "来源标签",
  contrast: "画面对比度",
  "animation-duration": "动效时长",
};

/** 失败即阻断的检查项；其余失败只作为警告。 */
export const BLOCKING_QUALITY_CHECK_IDS: ReadonlySet<QualityCheckId> = new Set([
  "subtitle-overflow",
  "source-label",
]);

/** 质检汇总：供 UI 的"N 项待处理"与服务端门禁判断。 */
export interface QualitySummary {
  /** fail 数量。 */
  failed: number;
  /** warn 数量。 */
  warned: number;
  /** 未执行（skipped）数量。 */
  skipped: number;
  /** 是否存在阻断型失败。 */
  blocking: boolean;
}

/**
 * 构造一条"未执行"的检查结论。
 * @param id 固定检查项 ID
 * @returns 状态为 skipped 的检查项
 */
function skippedCheck(id: QualityCheckId): QualityCheck {
  return { id, label: QUALITY_CHECK_LABELS[id], status: "skipped", violations: [] };
}

/**
 * 生成空质检报告：5 个固定检查项全部为 skipped。
 * 用于阶段启动时先落盘，后续检查执行后逐项覆盖。
 * @param runId 关联 run ID
 * @param generatedAt 生成时间（ISO 8601），缺省取当前时间
 * @returns 合法的空报告
 */
export function createEmptyQualityReport(runId: string, generatedAt?: string): QualityReport {
  return {
    version: "1",
    runId,
    generatedAt: generatedAt ?? new Date().toISOString(),
    checks: QUALITY_CHECK_IDS.map(skippedCheck),
  };
}

/**
 * 合并检查结果并补齐缺失项为 skipped，再按契约校验。
 * 同一检查项重复传入时以最后一次为准。
 * @param input runId、已执行检查项与可选生成时间
 * @returns 合法的完整报告
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 合并结果不满足契约时
 */
export function buildQualityReport(input: {
  runId: string;
  checks: QualityCheck[];
  generatedAt?: string;
}): QualityReport {
  const base = createEmptyQualityReport(input.runId, input.generatedAt);
  const byId = new Map<QualityCheckId, QualityCheck>(
    base.checks.map((check) => [check.id, check]),
  );
  for (const check of input.checks) {
    byId.set(check.id, check);
  }
  const merged = {
    ...base,
    checks: QUALITY_CHECK_IDS.map((id) => byId.get(id) ?? skippedCheck(id)),
  };
  return parseQualityReport(merged);
}

/**
 * 校验任意值是否为合法质检报告。
 * @param raw 待校验值
 * @param context 错误信息中的上下文（如路径）
 * @returns 合法报告
 */
function parseQualityReport(raw: unknown, context = "quality report"): QualityReport {
  const result = qualityReportSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `质检报告结构非法：${context}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 读取并校验 quality/report.json。
 * @param path 报告路径
 * @returns 合法报告
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 文件不可读、非 JSON 或结构非法时
 */
export function readQualityReport(path: string): QualityReport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `质检报告解析失败：${path}（${(err as Error).message}）`,
    );
  }
  return parseQualityReport(raw, path);
}

/**
 * 校验后写 quality/report.json；自动创建父目录。
 * @param path 输出路径
 * @param report 报告
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 报告不满足契约时
 */
export function writeQualityReport(path: string, report: QualityReport): void {
  const valid = parseQualityReport(report, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(valid, null, 2), "utf-8");
}

/**
 * 将检查状态映射为计数与阻断判断。
 * @param report 质检报告
 * @returns 汇总结果
 */
export function summarizeQualityReport(report: QualityReport): QualitySummary {
  return report.checks.reduce<QualitySummary>(
    (summary, check) => {
      if (check.status === "fail") {
        summary.failed += 1;
        if (BLOCKING_QUALITY_CHECK_IDS.has(check.id)) summary.blocking = true;
      } else if (check.status === "warn") {
        summary.warned += 1;
      } else if (check.status === "skipped") {
        summary.skipped += 1;
      }
      return summary;
    },
    { failed: 0, warned: 0, skipped: 0, blocking: false },
  );
}

/**
 * 判断单个检查状态是否属于阻断型失败。
 * @param id 检查项 ID
 * @param status 检查状态
 * @returns 是否阻断
 */
export function isBlockingFailure(id: QualityCheckId, status: QualityStatus): boolean {
  return status === "fail" && BLOCKING_QUALITY_CHECK_IDS.has(id);
}
