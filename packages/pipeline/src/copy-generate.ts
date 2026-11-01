import { VideoForgeError } from "@videoforge/shared";
import { arkChatCompletion } from "./ark-client.js";
import { copyDocSchema, writeCopyDoc, type CopyDoc } from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { loadPromptSet, renderTemplate, type PromptSet } from "./prompts.js";

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
 * copy:gen 阶段能力：主题 → 调用 Ark 文案模型 → 落盘 copy.json。
 * 仅读取显式入参，不读写进程 argv/stdout；诊断日志交调用方（CLI 层）处理。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.topic 视频主题
 * @param options.style 文案风格（CLI 层已填默认「科普」）
 * @param options.promptSet 提示词集名（--prompt-set）；缺省回退配置 prompts.default_set
 * @param options.outFile copy.json 输出路径
 * @param options.runId 运行 ID（--run-id）；缺省用输出目录名
 * @returns 落盘路径与场景数量（供调用方拼装 stdout JSON）
 */
export async function generateCopy(options: {
  rootDir: string;
  topic: string;
  style: string;
  promptSet?: string;
  outFile: string;
  runId?: string;
}): Promise<{ out: string; sceneCount: number }> {
  const { config, apiKey, ark } = loadArk(options.rootDir);
  if (ark.chat_model === "PLEASE_FILL_CHAT_MODEL_ID") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "请先在 config/system.local.yaml 填写 engines.endpoints.ark.chat_model",
    );
  }
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const text = await arkChatCompletion({
    baseUrl: ark.base_url,
    apiKey,
    model: ark.chat_model,
    messages: [
      { role: "system", content: renderTemplate(prompts.copySystem, { style: options.style }) },
      { role: "user", content: `主题：${options.topic}\n风格：${options.style}` },
    ],
  });
  const parsed = parseCopyJson(text, options.topic, options.style);
  writeCopyDoc(options.outFile, parsed);
  return { out: options.outFile, sceneCount: parsed.scenes.length };
}
