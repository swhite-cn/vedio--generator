import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arkGenerateImage } from "./ark-client.js";
import { readCopyDoc, writeCopyDoc } from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
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

/**
 * image:gen 阶段能力：逐场景调用 Ark 文生图，图片写入 <工作目录>/images/ 并回填 copy.json 的 imagePath。
 * 底图无文字约束后缀来自提示词集 image-suffix.txt：文字一律由 HTML 场景层渲染，
 * 避免文生图烘焙文字与动画文字叠加冲突（即使用户手写 copy.json 也强制追加）。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置、密钥与提示词集）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.promptSet 提示词集名（--prompt-set）；缺省回退配置 prompts.default_set
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 各场景回填后的图片路径（供调用方拼装 stdout JSON）
 */
export async function generateImages(options: {
  rootDir: string;
  copyPath: string;
  promptSet?: string;
  outFile?: string;
  runId?: string;
}): Promise<{ images: Array<string | undefined> }> {
  const doc = readCopyDoc(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const imagesDir = join(dirname(options.copyPath), "images");
  mkdirSync(imagesDir, { recursive: true });
  for (const scene of doc.scenes) {
    const imagePath = join(imagesDir, `${scene.sceneId}.png`);
    const buf = await arkGenerateImage({
      baseUrl: ark.base_url,
      apiKey,
      model: ark.image_model,
      prompt: `${scene.imagePrompt}。${prompts.imageSuffix}`,
      size: "2K",
    });
    writeFileSync(imagePath, buf);
    scene.imagePath = imagePath;
  }
  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { images: doc.scenes.map((s) => s.imagePath) };
}
