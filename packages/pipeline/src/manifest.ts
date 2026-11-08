import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 生成清单（generation manifest）：把每次模型调用的完整上下文追加式落盘到
 * `<项目目录>/manifest/generations.jsonl`，用于单场景精调时还原"当时到底发了什么"。
 *
 * 设计约束（见设计文档 §5.4、§11）：
 * - **追加式**：只 append，从不改写历史行；重新生成会生成新记录并通过 `supersedesId` 串联；
 * - **随项目走**：文件落在项目目录内，便于整体导出 / 迁移 / 手工查看；
 * - **不含密钥**：只记录提示词、模型名、参数与结果元数据，绝不写 apiKey；
 * - **失败也记**：`ok=false` 记录同样保留，便于解释降级产物与失败原因。
 */

/** 清单文件相对项目目录的路径（POSIX `/` 分隔）。 */
export const GENERATION_MANIFEST_PATH = "manifest/generations.jsonl";

/** 产生清单记录的能力阶段。 */
export type GenerationStage = "copy" | "image" | "scene" | "tts";

/** 一条生成记录：一次模型调用对应一行 JSON。 */
export interface GenerationRecord {
  /** 记录 ID（UUID）。 */
  id: string;
  /** 归属 run；缺省表示非工作流触发（如 CLI 直跑）。 */
  runId?: string;
  /** 产生该记录的阶段。 */
  stage: GenerationStage;
  /** 场景 ID；整篇类产物（copy）缺省。 */
  sceneId?: string;
  /** 镜头 ID（v2）；用于按镜头建立版本链。 */
  shotId?: string;
  /** 产物相对项目目录的路径（POSIX `/`），如 `images/s1.png`。 */
  assetPath?: string;
  /** 实际调用的模型 ID 或资源 ID。 */
  model?: string;
  /** 使用的提示词集名（`config/prompts/<名>/`）。 */
  promptSet?: string;
  /** 实际发给模型的完整提示词（含后缀与系统提示）。 */
  prompt?: string;
  /** 提示词 SHA-256，便于快速比对两次生成是否同源。 */
  promptSha256?: string;
  /** 本次调用的额外参数（尺寸、音色等）。 */
  params?: Record<string, unknown>;
  /** 生效的提示词模板快照：模板文件会变，这里固化当时内容。 */
  templateSnapshot?: Record<string, string>;
  /** 是否成功产出。 */
  ok: boolean;
  /** 失败时的稳定错误码。 */
  errorCode?: string;
  /** 失败时的可读说明（已脱敏，不含密钥）。 */
  errorMessage?: string;
  /** 是否降级为内置模板（场景阶段）。 */
  fallback?: boolean;
  /** 调用耗时（毫秒）。 */
  durationMs?: number;
  /** 覆盖掉的上一条同类记录 ID（版本链）。 */
  supersedesId?: string;
  /** 生成时生效的契约版本；旧记录缺省按 `1.0` 读取。 */
  contractVersion?: string;
  /** 记录时间（ISO 8601）。 */
  createdAt: string;
}

/** 追加记录时的入参：`id` / `createdAt` / `supersedesId` 由本模块补齐。 */
export type GenerationRecordInput = Omit<GenerationRecord, "id" | "createdAt" | "supersedesId">;

/**
 * 计算文本的 SHA-256 摘要（用于提示词同源比对）。
 * @param text 待摘要文本
 * @returns 十六进制摘要
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 读取项目内的全部生成记录；文件缺失或单行损坏时跳过，不让审计数据影响主流程。
 * @param projectDir 项目工作目录
 * @returns 按写入顺序排列的记录数组
 */
export function readGenerationRecords(projectDir: string): GenerationRecord[] {
  const path = join(projectDir, GENERATION_MANIFEST_PATH);
  if (!existsSync(path)) return [];
  const records: GenerationRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as GenerationRecord;
      if (parsed && typeof parsed.id === "string") {
        // 旧记录没有契约版本字段，读取时归一化为 1.0，避免下游出现 undefined
        records.push({ ...parsed, contractVersion: parsed.contractVersion ?? "1.0" });
      }
    } catch {
      // 损坏行按缺失处理：审计数据不应阻断生成主流程
    }
  }
  return records;
}

/**
 * 查找同一阶段、同一产物的最后一条记录，用于建立版本链（`supersedesId`）。
 * @param records 已有记录
 * @param input 本次记录的归属信息
 * @returns 命中的最后一条记录；没有则 undefined
 */
function findPrevious(
  records: GenerationRecord[],
  input: GenerationRecordInput,
): GenerationRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.stage !== input.stage) continue;
    if (input.shotId && record.shotId !== input.shotId) continue;
    // 非镜头记录仍按场景匹配；整篇记录（copy）不限制场景
    if (!input.shotId && input.sceneId && record.sceneId !== input.sceneId) continue;
    if (input.assetPath && record.assetPath && record.assetPath !== input.assetPath) continue;
    return record;
  }
  return undefined;
}

/**
 * 追加一条生成记录到项目清单（自动补齐 ID、时间与版本链）。
 * 写盘失败只输出告警，不抛出——留痕问题不应让已生成好的产物失败。
 * @param projectDir 项目工作目录
 * @param input 记录内容
 * @returns 落盘后的完整记录（即使写盘失败也返回，便于调用方拼接摘要）
 */
export function appendGenerationRecord(
  projectDir: string,
  input: GenerationRecordInput,
): GenerationRecord {
  const previous = findPrevious(readGenerationRecords(projectDir), input);
  const record: GenerationRecord = {
    ...input,
    id: randomUUID(),
    contractVersion: input.contractVersion ?? "1.0",
    createdAt: new Date().toISOString(),
    ...(previous ? { supersedesId: previous.id } : {}),
    ...(input.prompt ? { promptSha256: sha256(input.prompt) } : {}),
  };
  try {
    const path = join(projectDir, GENERATION_MANIFEST_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `[manifest] 生成记录写入失败（${input.stage}${input.sceneId ? `/${input.sceneId}` : ""}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return record;
}

/**
 * 取每个产物的最新一条生成记录（按 `stage + assetPath/sceneId` 去重）。
 * 记录是追加式的，后写入即更新，因此 Map 覆盖天然得到最新版本。
 * @param projectDir 项目工作目录
 * @returns 每个产物当前生效的生成上下文
 */
export function latestGenerationRecords(projectDir: string): GenerationRecord[] {
  const latest = new Map<string, GenerationRecord>();
  for (const record of readGenerationRecords(projectDir)) {
    const key = `${record.stage}:${record.assetPath ?? record.shotId ?? record.sceneId ?? ""}`;
    latest.set(key, record);
  }
  return [...latest.values()];
}

/**
 * 校验并归一化场景范围入参：未指定时返回全部场景，指定时必须是 copy.json 中真实存在的 sceneId。
 * @param allSceneIds 文档中的全部场景 ID
 * @param requested 调用方传入的 sceneId 列表（可为空）
 * @returns 归一化后的（去重、保持文档顺序的）场景 ID 列表
 * @throws VideoForgeError(`CONFIG_INVALID`) 传入不存在的 sceneId
 */
export function resolveSceneScope(allSceneIds: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) return allSceneIds;
  const wanted = new Set(requested.map((id) => id.trim()).filter((id) => id.length > 0));
  const unknown = [...wanted].filter((id) => !allSceneIds.includes(id));
  if (unknown.length > 0) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `未知的场景 ID：${unknown.join(", ")}；可选值：${allSceneIds.join(", ")}`,
    );
  }
  return allSceneIds.filter((id) => wanted.has(id));
}
