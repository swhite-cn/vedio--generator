import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";
import { arkGenerateImage } from "./ark-client.js";
import { readCopyDoc, writeCopyDoc } from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord, resolveSceneScope } from "./manifest.js";
import { loadPromptSet, type PromptSet } from "./prompts.js";

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

/** 旧图归档子目录（相对 images/）：定向重生成前保留上一版，便于回退。 */
const HISTORY_DIR = "history";

/** 用时间戳生成不会冲突的归档文件名。 */
function archiveName(sceneId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${sceneId}-${stamp}.png`;
}

/**
 * image:gen 阶段能力：逐场景调用 Ark 文生图，图片写入 <工作目录>/images/ 并回填 copy.json 的 imagePath。
 * 底图无文字约束后缀来自提示词集 image-suffix.txt：文字一律由 HTML 场景层渲染，
 * 避免文生图烘焙文字与动画文字叠加冲突（即使用户手写 copy.json 也强制追加）。
 *
 * 支持定向重生成：`sceneIds` 只重跑指定场景（其余图片原样保留），`promptOverride` 用于单场景精调；
 * 覆盖前把旧图归档到 `images/history/`，并把实际提示词写入 `manifest/generations.jsonl`。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.promptSet 提示词集名（--prompt-set）；缺省回退配置 prompts.default_set
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @param options.sceneIds 只重生成这些场景；缺省为全部场景
 * @param options.promptOverride 覆盖该场景的画面描述（仅允许单场景，配合 sceneIds 使用）
 * @param options.mode `all` 全量重画；`missing` 只补缺失图片，已存在的保持不动
 * @returns 各场景回填后的图片路径、本次实际生成的场景 ID 与降级说明
 */
export async function generateImages(options: {
  rootDir: string;
  copyPath: string;
  promptSet?: string;
  outFile?: string;
  runId?: string;
  sceneIds?: string[];
  promptOverride?: string;
  mode?: "all" | "missing";
}): Promise<{ images: Array<string | undefined>; generated: string[] }> {
  const doc = readCopyDoc(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const projectDir = dirname(options.copyPath);
  const imagesDir = join(projectDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  const scope = resolveSceneScope(
    doc.scenes.map((scene) => scene.sceneId),
    options.sceneIds,
  );
  if (options.promptOverride !== undefined && scope.length !== 1) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "promptOverride 只能配合单个 sceneId 使用，避免同一描述覆盖多个场景",
    );
  }

  const generated: string[] = [];
  for (const sceneId of scope) {
    const scene = doc.scenes.find((item) => item.sceneId === sceneId);
    if (!scene) continue;
    const imagePath = join(imagesDir, `${sceneId}.png`);
    if (options.mode === "missing" && existsSync(imagePath)) continue;

    const prompt = `${options.promptOverride ?? scene.imagePrompt}。${prompts.imageSuffix}`;
    const startedAt = Date.now();
    try {
      const buf = await arkGenerateImage({
        baseUrl: ark.base_url,
        apiKey,
        model: ark.image_model,
        prompt,
        size: "2K",
      });
      // 覆盖前归档旧图：定向重生成可能反复迭代，保留每一版便于回退
      if (existsSync(imagePath)) {
        const historyDir = join(imagesDir, HISTORY_DIR);
        mkdirSync(historyDir, { recursive: true });
        renameSync(imagePath, join(historyDir, archiveName(sceneId, new Date())));
      }
      writeFileSync(imagePath, buf);
      scene.imagePath = imagePath;
      generated.push(sceneId);
      appendGenerationRecord(projectDir, {
        runId: options.runId,
        stage: "image",
        sceneId,
        assetPath: `images/${sceneId}.png`,
        model: ark.image_model,
        promptSet: prompts.name,
        prompt,
        params: {
          size: "2K",
          mode: options.mode ?? "all",
          overridden: options.promptOverride !== undefined,
        },
        templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      appendGenerationRecord(projectDir, {
        runId: options.runId,
        stage: "image",
        sceneId,
        assetPath: `images/${sceneId}.png`,
        model: ark.image_model,
        promptSet: prompts.name,
        prompt,
        params: { size: "2K", mode: options.mode ?? "all" },
        templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
        ok: false,
        errorCode: error instanceof VideoForgeError ? error.code : "ADAPTER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { images: doc.scenes.map((s) => s.imagePath), generated };
}
