import {
  readGenerationRecords,
  type GenerationRecord,
  type GenerationStage,
} from "@videoforge/pipeline";
import type { TraceStore } from "./trace-store.js";

/**
 * 生成清单 → `llm_calls` 镜像。
 *
 * 阶段生成的模型调用发生在 `packages/pipeline` 内（不经过 Pi provider），因此不会自动进入
 * `llm_calls`。这里在阶段工具执行完成后，把本次新增的生成清单记录镜像为 LLM 调用留痕，
 * 让 trace 页同时能看到「对话模型调用」与「生成阶段模型调用」。
 *
 * 取舍：
 * - pipeline 层保持无数据库依赖，镜像统一放在 server 侧；
 * - 以「执行开始时间 + 阶段」筛选新增记录，重试产生的新记录会各自留痕，历史记录不重复写入；
 * - 图像 / TTS 不返回 token 用量，`promptTokens` / `completionTokens` 记 0；
 * - 图像返回体是 base64，**不写进 response**，只记录元数据。
 */

/** 阶段工具名 → 生成清单阶段。 */
const TOOL_STAGE: Readonly<Record<string, GenerationStage>> = {
  copy_generate: "copy",
  image_generate: "image",
  scene_generate: "scene",
  tts_generate: "tts",
};

/** 镜像所需的留痕上下文。 */
export interface GenerationMirrorContext {
  trace: TraceStore;
  sessionId: string;
  runId?: string | null;
  stageId?: string | null;
  projectDir: string;
}

/**
 * 把某次阶段工具执行新增的生成记录写入 `llm_calls`。
 * 单个记录写入失败只告警，绝不影响已经完成的生成结果。
 * @param context 留痕上下文
 * @param toolName 阶段工具名（仅 copy/image/scene/tts 生效）
 * @param startedAtIso 本次执行开始时间（ISO 8601）
 */
export function mirrorGenerationRecords(
  context: GenerationMirrorContext,
  toolName: string,
  startedAtIso: string,
): void {
  const stage = TOOL_STAGE[toolName];
  if (!stage) return;

  let records: GenerationRecord[];
  try {
    records = readGenerationRecords(context.projectDir);
  } catch (error) {
    console.warn(
      `[generation-mirror] 读取生成清单失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  for (const record of records) {
    if (record.stage !== stage) continue;
    if (record.createdAt < startedAtIso) continue;
    try {
      context.trace.recordLlmCall({
        sessionId: context.sessionId,
        runId: context.runId ?? null,
        stageId: context.stageId ?? null,
        model: record.model ?? toolName,
        request: {
          stage: record.stage,
          sceneId: record.sceneId ?? null,
          promptSet: record.promptSet ?? null,
          prompt: record.prompt ?? null,
          params: record.params ?? null,
        },
        response: {
          ok: record.ok,
          fallback: record.fallback ?? false,
          assetPath: record.assetPath ?? null,
          errorCode: record.errorCode ?? null,
        },
        promptTokens: 0,
        completionTokens: 0,
        durationMs: record.durationMs ?? 0,
        // 降级场景的模型调用本身是失败的，ok 反映"模型调用是否成功"
        ok: record.ok && !record.fallback,
        errorCode: record.errorCode ?? null,
      });
    } catch (error) {
      console.warn(
        `[generation-mirror] 写入 llm_calls 失败（${record.stage}${record.sceneId ? `/${record.sceneId}` : ""}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
