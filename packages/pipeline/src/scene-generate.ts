import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import {
  assertSceneCodeSafe,
  buildFallbackSceneCode,
  getProfile,
  sceneCodeSchema,
  vendorGsap,
  wrapSceneDocument,
  type SceneCode,
} from "@videoforge/template-sdk";
import { arkChatCompletion } from "./ark-client.js";
import { readCopyDoc, writeCopyDoc } from "./copy-contract.js";
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

/** 从模型输出解析场景代码（容忍 ```json 围栏）；结构或安全校验非法抛 ADAPTER_PROTOCOL_INVALID */
function parseSceneCodeJson(text: string): SceneCode {
  const cleaned = text
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "场景模型未输出合法 JSON");
  }
  const result = sceneCodeSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `场景 JSON 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  assertSceneCodeSafe(result.data);
  return result.data;
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

/** 降级场景 HTML 文件头标记：--only-fallbacks 断点续跑时据此识别需重生成的场景 */
const FALLBACK_MARKER = "<!-- videoforge:fallback -->";

/**
 * 限并发映射：按顺序取任务、最多 concurrency 个同时进行，结果保持入参顺序；
 * 单个任务失败不中断其他任务，错误收集到 results 中由调用方处理。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * scene:gen 阶段能力：调用 Ark 生成 HTML+GSAP 动画场景，落盘 <工作目录>/scenes/<sceneId>.html 并回填 htmlPath；
 * 单场景模型输出不可用时降级内置动画模板（Ken Burns + 字幕条），不中断整批生成。
 * 多场景按 concurrency 限并发执行；onlyFallbacks=true 时仅重生成 html 缺失或仍带降级标记的场景
 * （断点续跑），已成功的 LLM 场景原样保留。仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.promptSet 提示词集名（--prompt-set）；缺省回退配置 prompts.default_set
 * @param options.profile 输出画幅（CLI 层已校验并填默认）
 * @param options.onlyFallbacks true 时仅重生成降级/缺失场景（--only-fallbacks）
 * @param options.concurrency 限并发度（CLI 层已取默认 3）
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 各场景 HTML 路径与降级场景 ID 列表（供调用方拼装 stdout JSON）
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
}): Promise<{ scenes: Array<string | undefined>; fallbacks: string[] }> {
  const doc = readCopyDoc(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  if (ark.chat_model === "PLEASE_FILL_CHAT_MODEL_ID") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "请先在 config/system.local.yaml 填写 engines.endpoints.ark.chat_model",
    );
  }
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const profile = options.profile;
  const spec = getProfile(profile);
  // 场景系统提示词支持 {width}/{height} 模板变量，按画幅注入
  const sceneSystemPrompt = renderTemplate(prompts.sceneSystem, {
    width: spec.width,
    height: spec.height,
  });
  const workDir = dirname(options.copyPath);
  vendorGsap(join(workDir, "vendor"));
  const scenesDir = join(workDir, "scenes");
  mkdirSync(scenesDir, { recursive: true });
  const onlyFallbacks = options.onlyFallbacks;
  const concurrency = options.concurrency;
  // 断点续跑：仅挑选 html 缺失或文件头带降级标记的场景重新生成
  const pending = doc.scenes.filter((scene) => {
    if (!onlyFallbacks) return true;
    const htmlPath = scene.htmlPath ?? join(scenesDir, `${scene.sceneId}.html`);
    if (!existsSync(htmlPath)) return true;
    return readFileSync(htmlPath, "utf-8").includes(FALLBACK_MARKER);
  });
  const fallbacks: string[] = [];
  await mapWithConcurrency(pending, concurrency, async (scene) => {
    const imageRelPath = scene.imagePath ? `../images/${basename(scene.imagePath)}` : undefined;
    let code: SceneCode;
    let fallback = false;
    try {
      const text = await arkChatWithRetry({
        baseUrl: ark.base_url,
        apiKey,
        model: ark.chat_model,
        messages: [
          { role: "system", content: sceneSystemPrompt },
          {
            role: "user",
            content: [
              `场景标题：${scene.title}`,
              `口播文案：${scene.narration}`,
              `画幅：${spec.width}x${spec.height}`,
              `底图相对路径（可作为 <img> 的 src 直接引用）：${imageRelPath ?? "无（请用渐变背景）"}`,
            ].join("\n"),
          },
        ],
      });
      code = parseSceneCodeJson(text);
    } catch (err) {
      fallback = true;
      console.info(
        `[scene:gen] 场景 ${scene.sceneId} 模型输出不可用，降级内置动画：${(err as Error).message}`,
      );
      code = buildFallbackSceneCode(
        { sceneId: scene.sceneId, title: scene.title, narration: scene.narration },
        imageRelPath,
      );
      fallbacks.push(scene.sceneId);
    }
    const htmlPath = join(scenesDir, `${scene.sceneId}.html`);
    const html = wrapSceneDocument(code, { width: spec.width, height: spec.height });
    // 降级产物写入文件头标记，供 --only-fallbacks 续跑时识别
    writeFileSync(htmlPath, (fallback ? FALLBACK_MARKER + "\n" : "") + html, "utf-8");
    scene.htmlPath = htmlPath;
  });
  fallbacks.sort();
  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { scenes: doc.scenes.map((s) => s.htmlPath), fallbacks };
}
