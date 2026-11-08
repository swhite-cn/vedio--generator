import { dirname } from "node:path";
import {
  CONTRACT_VERSION_V2,
  VideoForgeError,
  copyDocV2Schema,
  type CopyDocV2,
} from "@videoforge/shared";
import { arkChatCompletion } from "./ark-client.js";
import {
  copyDocSchema,
  writeCopyDoc,
  writeCopyDocV2,
  type CopyDoc,
} from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord } from "./manifest.js";
import { loadPromptSet, renderTemplate, type PromptSet } from "./prompts.js";

/** v2 项目未显式指定主题时的兜底主题 ID（T111 接入主题解析后由项目快照覆盖）。 */
export const DEFAULT_THEME_ID = "documentary-dark";

/** 加载系统配置与 Ark 凭据；配置非法或密钥缺失时由底层抛错（不记录密钥） */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  return { config, apiKey, ark: config.engines.endpoints.ark };
}

/** 解析本次使用的提示词集：显式 promptSet 优先，其次配置 prompts.default_set，缺省 default */
function resolvePrompts(
  rootDir: string,
  promptSet: string | undefined,
  config: SystemConfig,
): PromptSet {
  return loadPromptSet({
    rootDir,
    setName: promptSet?.trim() || config.prompts?.default_set,
  });
}

/** 从模型输出解析文案文档（容忍 ```json 围栏），结构非法抛 ADAPTER_PROTOCOL_INVALID */
function parseCopyJson(text: string, topic: string, style: string): CopyDoc {
  const cleaned = text
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "文案模型未输出合法 JSON");
  }
  const result = copyDocSchema.safeParse({ topic, style, ...(raw as Record<string, unknown>) });
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `文案 JSON 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

/**
 * 从模型输出解析 copy.json v2（一句一镜）。
 * 顶层 topic/style/theme 由调用方注入，模型只负责 title/styleAnchors/scenes。
 * @param text 模型原始输出（容忍 ```json 围栏）
 * @param input 主题、风格与主题 ID
 * @returns v2 文案文档
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 非 JSON 或结构非法时
 */
export function parseCopyV2Json(
  text: string,
  input: { topic: string; style: string; themeId?: string },
): CopyDocV2 {
  const cleaned = text
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "文案模型未输出合法 JSON");
  }
  const result = copyDocV2Schema.safeParse({
    contractVersion: CONTRACT_VERSION_V2,
    topic: input.topic,
    style: input.style,
    theme: { id: input.themeId?.trim() || DEFAULT_THEME_ID },
    ...(raw as Record<string, unknown>),
  });
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `文案 JSON v2 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

/**
 * copy:gen 阶段能力：主题 → 调用 Ark 文案模型 → 落盘 copy.json。
 * 仅读取显式入参，不读写进程 argv/stdout；诊断日志交调用方（CLI 层）处理。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.topic 视频主题
 * @param options.style 文案风格（CLI 层已填默认「科普」）
 * @param options.promptSet 提示词集名（--prompt-set）；缺省回退配置 prompts.default_set
 * @param options.contractVersion 契约版本；`2.0` 时产出 shots[]，缺省 `1.0` 保持旧行为
 * @param options.themeId v2 主题 ID；缺省 `documentary-dark`
 * @param options.outFile copy.json 输出路径
 * @param options.runId 运行 ID（--run-id）；缺省用输出目录名
 * @returns 落盘路径、场景数量与（v2）镜头数量
 */
export async function generateCopy(options: {
  rootDir: string;
  topic: string;
  style: string;
  promptSet?: string;
  contractVersion?: string;
  themeId?: string;
  outFile: string;
  runId?: string;
}): Promise<{ out: string; sceneCount: number; shotCount?: number }> {
  const { config, apiKey, ark } = loadArk(options.rootDir);
  if (ark.chat_model === "PLEASE_FILL_CHAT_MODEL_ID") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "请先在 config/system.local.yaml 填写 engines.endpoints.ark.chat_model",
    );
  }
  const isV2 = options.contractVersion === CONTRACT_VERSION_V2;
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const systemPrompt = renderTemplate(
    isV2 ? prompts.copyV2System : prompts.copySystem,
    { style: options.style },
  );
  const userPrompt = `主题：${options.topic}\n风格：${options.style}`;
  const startedAt = Date.now();
  const text = await arkChatCompletion({
    baseUrl: ark.base_url,
    apiKey,
    model: ark.chat_model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const parsedV1 = isV2
    ? undefined
    : parseCopyJson(text, options.topic, options.style);
  const parsedV2 = isV2
    ? parseCopyV2Json(text, {
        topic: options.topic,
        style: options.style,
        themeId: options.themeId,
      })
    : undefined;

  if (parsedV2) {
    writeCopyDocV2(options.outFile, parsedV2);
  } else if (parsedV1) {
    writeCopyDoc(options.outFile, parsedV1);
  }

  const shotCount = parsedV2
    ? parsedV2.scenes.reduce((total, scene) => total + scene.shots.length, 0)
    : undefined;
  const sceneCount = parsedV2?.scenes.length ?? parsedV1?.scenes.length ?? 0;

  // 文案是后续所有场景的源头，必须留痕：精调单个分镜时需要回溯当时的选题与风格
  appendGenerationRecord(dirname(options.outFile), {
    runId: options.runId,
    stage: "copy",
    assetPath: "copy.json",
    model: ark.chat_model,
    promptSet: prompts.name,
    prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
    params: { topic: options.topic, style: options.style, sceneCount, shotCount },
    templateSnapshot: {
      "copy-system.txt": isV2 ? prompts.copyV2System : prompts.copySystem,
    },
    ok: true,
    contractVersion: isV2 ? CONTRACT_VERSION_V2 : "1.0",
    durationMs: Date.now() - startedAt,
  });
  return { out: options.outFile, sceneCount, shotCount };
}
