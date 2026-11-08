import { dirname } from "node:path";
import {
  VideoForgeError,
  type CopyDocV2,
  type OutputProfile,
  type ShotV2,
} from "@videoforge/shared";
import { arkChatCompletion } from "./ark-client.js";
import { readCopyDocument } from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord, resolveSceneScope } from "./manifest.js";
import { loadPromptSet, renderTemplate, type PromptSet } from "./prompts.js";
import { SCENE_SPEC_RELATIVE_PATH, readSceneSpec, writeSceneSpec } from "./scene-spec-store.js";
import {
  buildShotSpecs,
  formatComponentCatalog,
  mergeSceneSpecShots,
  parseSceneSelectionJson,
} from "./scene-spec-build.js";
import { readThemeSnapshot } from "./theme.js";

/**
 * scene 阶段能力（v2）：模型只做组件选型与填参，产物为 `scenes/spec.json`。
 *
 * T501 起 legacy 场景代码路径（LLM 直出 HTML/GSAP + 降级模板）已随渲染通道一并移除，
 * 仅支持 v2 项目；旧项目（copy.json 契约版本 1.0）给出明确迁移提示。
 * 仅读取显式入参，不读写进程 argv/stdout。
 */

/** 加载系统配置与 Ark 凭据；配置非法或密钥缺失时由底层抛错（不记录密钥）。 */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  return { config, apiKey, ark: config.engines.endpoints.ark };
}

/** 解析本次使用的提示词集：显式 promptSet 优先，其次配置 prompts.default_set，缺省 default。 */
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

/**
 * 带单次重试的 Ark chat 调用：仅对连接层瞬时错误（如 fetch failed）重试一次，
 * HTTP 错误与模型输出解析/校验等确定性错误不重试，交由调用方降级处理。
 */
async function arkChatWithRetry(options: Parameters<typeof arkChatCompletion>[0]): Promise<string> {
  try {
    return await arkChatCompletion(options);
  } catch (err) {
    if (err instanceof VideoForgeError) throw err;
    return await arkChatCompletion(options);
  }
}

/** v2 场景生成的运行上下文（由 generateScenes 组装，避免重复加载配置/密钥）。 */
interface SceneSpecV2Context {
  copy: CopyDocV2;
  workDir: string;
  config: SystemConfig;
  apiKey: string;
  ark: SystemConfig["engines"]["endpoints"]["ark"];
  prompts: PromptSet;
}

/**
 * scene 阶段能力：调用 Ark 选型填参并落盘 `<工作目录>/scenes/spec.json`（v2）。
 * 模型整体失败时所有 component 镜头降级关键词块，非 component 镜头仍按 copy 装配，不中断整批。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.copyPath 输入 copy.json 路径（必须是 v2）
 * @param options.promptSet 提示词集名；缺省回退配置 prompts.default_set
 * @param options.profile 输出画幅（仅保留入参兼容，v2 选型不需要）
 * @param options.onlyFallbacks true 时已有 spec 条目的镜头不重复选型（断点续跑）
 * @param options.concurrency 限并发度（v2 选型为单次调用，保留入参兼容）
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @param options.sceneIds 只重生成这些场景；缺省为全部场景
 * @param options.promptOverride 单场景额外要求（仅允许配合单个 sceneId 使用）
 * @returns spec.json 路径、降级镜头 ID 列表与已装配镜头 ID 列表
 * @throws VideoForgeError(`CONFIG_INVALID`) 项目仍是 v1（legacy 路径已移除）
 */
export async function generateScenes(options: {
  rootDir: string;
  copyPath: string;
  promptSet?: string;
  profile: OutputProfile;
  onlyFallbacks: boolean;
  concurrency: number;
  outFile?: string;
  runId?: string;
  sceneIds?: string[];
  promptOverride?: string;
}): Promise<{ scenes: Array<string | undefined>; fallbacks: string[]; generated: string[] }> {
  const document = readCopyDocument(options.copyPath);
  // T501：legacy 场景/渲染代码路径已移除，仅支持 v2 项目
  if (document.version !== "2") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "旧项目（copy.json 契约版本 1.0）不再支持场景生成：legacy HTML/GSAP 场景与 Playwright 渲染通道已在 v2 重构中移除，请用当前版本新建项目重新生成。",
    );
  }
  const workDir = dirname(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  if (ark.chat_model === "PLEASE_FILL_CHAT_MODEL_ID") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "请先在 config/system.local.yaml 填写 engines.endpoints.ark.chat_model",
    );
  }
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  return generateSceneSpecsV2(options, {
    copy: document.doc,
    workDir,
    config,
    apiKey,
    ark,
    prompts,
  });
}

/**
 * 构造选型请求的用户内容：只给 component 镜头与必要上下文，避免把整份 copy 塞进提示词。
 * @param shots 待选型的 component 镜头
 * @param promptOverride 单镜头额外要求（可选）
 * @returns JSON 文本
 */
function buildSceneSelectionUserContent(shots: ShotV2[], promptOverride?: string): string {
  const payload = {
    shots: shots.map((shot) => ({
      shotId: shot.shotId,
      narration: shot.narration,
      onScreenText: shot.onScreenText,
      emphasis: shot.emphasis,
      visualType: shot.visualType,
      sourceRef: shot.sourceRef ?? null,
    })),
    ...(promptOverride ? { extraRequirement: promptOverride } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * v2 scene 阶段：模型只选型填参 → 装配期校验/降级 → 合并写 `scenes/spec.json`。
 * 模型整体失败时所有 component 镜头降级关键词块，非 component 镜头仍按 copy 装配。
 * @param options generateScenes 的原始入参
 * @param context 配置、密钥、提示词与工作目录
 * @returns spec.json 路径、降级镜头 ID 与已装配镜头 ID
 */
async function generateSceneSpecsV2(
  options: {
    rootDir: string;
    copyPath: string;
    promptSet?: string;
    profile: OutputProfile;
    onlyFallbacks: boolean;
    concurrency: number;
    outFile?: string;
    runId?: string;
    sceneIds?: string[];
    promptOverride?: string;
  },
  context: SceneSpecV2Context,
): Promise<{ scenes: Array<string | undefined>; fallbacks: string[]; generated: string[] }> {
  const { copy, workDir, apiKey, ark, prompts } = context;
  const existing = readSceneSpec(workDir);

  // 定向范围沿用 sceneIds（每镜归属章节）；promptOverride 仍只允许单场景
  const scope = resolveSceneScope(
    copy.scenes.map((scene) => scene.sceneId),
    options.sceneIds,
  );
  if (options.promptOverride !== undefined && scope.length !== 1) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "promptOverride 只能配合单个 sceneId 使用，避免同一要求覆盖多个场景",
    );
  }
  const scopeSet = new Set(scope);
  const scopedShots = copy.scenes
    .filter((scene) => scopeSet.has(scene.sceneId))
    .flatMap((scene) => scene.shots);

  // 断点续跑：已有 spec 条目的镜头不重复选型
  const pending = options.onlyFallbacks
    ? scopedShots.filter((shot) => !existing?.shots.some((spec) => spec.shotId === shot.shotId))
    : scopedShots;
  const componentShots = pending.filter((shot) => shot.visualType === "component");

  // 动效时长取主题 motion 边界内的 400ms，缺主题快照时用默认值
  let animationDurationMs = 400;
  try {
    const theme = readThemeSnapshot(workDir)?.theme;
    if (theme) {
      animationDurationMs = Math.min(
        Math.max(400, theme.motion.min_duration_ms),
        theme.motion.max_duration_ms,
      );
    }
  } catch (err) {
    console.warn(
      `[scene:gen] 读取主题快照失败，动效使用默认 400ms：${(err as Error).message}`,
    );
  }

  let selections: ReturnType<typeof parseSceneSelectionJson> = [];
  let failure: unknown;
  let arkDurationMs = 0;
  if (componentShots.length > 0) {
    const systemPrompt = renderTemplate(prompts.sceneV2System, {
      catalog: formatComponentCatalog(),
    });
    const userContent = buildSceneSelectionUserContent(componentShots, options.promptOverride);
    const startedAt = Date.now();
    try {
      const text = await arkChatWithRetry({
        baseUrl: ark.base_url,
        apiKey,
        model: ark.chat_model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      });
      selections = parseSceneSelectionJson(text);
    } catch (err) {
      failure = err;
      console.info(
        `[scene:gen] 组件选型不可用，全部降级关键词块：${(err as Error).message}`,
      );
    }
    arkDurationMs = Date.now() - startedAt;
    appendGenerationRecord(workDir, {
      runId: options.runId,
      stage: "scene",
      assetPath: SCENE_SPEC_RELATIVE_PATH,
      model: ark.chat_model,
      promptSet: prompts.name,
      prompt: `${systemPrompt}\n\n---\n\n${userContent}`,
      params: {
        componentShots: componentShots.length,
        pendingShots: pending.length,
        overridden: options.promptOverride !== undefined,
      },
      templateSnapshot: { "scene-v2-system.txt": prompts.sceneV2System },
      ok: failure === undefined,
      fallback: failure !== undefined,
      ...(failure
        ? {
            errorCode: failure instanceof VideoForgeError ? failure.code : "ADAPTER_FAILED",
            errorMessage: failure instanceof Error ? failure.message : String(failure),
          }
        : {}),
      durationMs: arkDurationMs,
      contractVersion: "2.0",
    });
  }

  const built = buildShotSpecs({
    copy,
    selections,
    shotIds: pending.map((shot) => shot.shotId),
    animationDurationMs,
  });
  const merged = mergeSceneSpecShots(existing, built.shots, copy.theme.id);
  writeSceneSpec(workDir, merged);

  return {
    scenes: [SCENE_SPEC_RELATIVE_PATH],
    fallbacks: built.fallbackShotIds,
    generated: built.shots.map((shot) => shot.shotId),
  };
}
