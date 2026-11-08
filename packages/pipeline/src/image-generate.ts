import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VideoForgeError,
  type CopyDocV2,
  type ShotV2,
  type StyleAnchor,
} from "@videoforge/shared";
import { arkGenerateImage } from "./ark-client.js";
import {
  readCopyDocument,
  writeCopyDoc,
  writeCopyDocV2,
  type CopyDoc,
} from "./copy-contract.js";
import { loadSystemConfig, type SystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord, resolveSceneScope } from "./manifest.js";
import { loadPromptSet, type PromptSet } from "./prompts.js";

/** Ark 端点类型（从系统配置派生，避免重复声明字段）。 */
type ArkEndpoint = SystemConfig["engines"]["endpoints"]["ark"];

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
function archiveName(id: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${id}-${stamp}.png`;
}

/**
 * 为文本生成稳定的正整数 seed（FNV-1a），用于图像生成的可复现性。
 * @param text 种子文本，例如 `anchor:mercury` 或 `shot:sh-001:mercury`
 * @returns 0..2147483646 的整数
 */
export function stableSeed(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647;
}

/**
 * 组合镜头图片提示词：口播内容 + 屏上要点 + 强调元素 + 风格锚 + 无文字后缀。
 * @param shot 镜头
 * @param anchors 本镜引用的风格锚
 * @param suffix 提示词集的无文字后缀
 * @returns 完整提示词
 */
export function buildShotImagePrompt(
  shot: ShotV2,
  anchors: StyleAnchor[],
  suffix: string,
): string {
  const anchorText = anchors.map((anchor) => `${anchor.label}（${anchor.color}）`).join("、");
  return [
    `镜头画面：${shot.narration}`,
    shot.onScreenText ? `画面要点：${shot.onScreenText}` : "",
    shot.emphasis.length > 0 ? `强调元素：${shot.emphasis.join("、")}` : "",
    anchorText ? `复用的固定符号：${anchorText}` : "",
    `视觉类型：${shot.visualType}`,
    suffix,
  ]
    .filter((part) => part.length > 0)
    .join("。");
}

/** image 阶段可选参数。 */
export interface GenerateImagesOptions {
  rootDir: string;
  copyPath: string;
  promptSet?: string;
  outFile?: string;
  runId?: string;
  /** v1：按场景定向。 */
  sceneIds?: string[];
  /** v2：按镜头定向。 */
  shotIds?: string[];
  promptOverride?: string;
  mode?: "all" | "missing";
}

/**
 * 覆盖前归档旧图，避免定向重生成丢失上一版。
 * @param imagesDir 图片目录
 * @param id 场景/镜头/锚点 ID
 * @param imagePath 当前图片绝对路径
 */
function archiveExistingImage(imagesDir: string, id: string, imagePath: string): void {
  if (!existsSync(imagePath)) return;
  const historyDir = join(imagesDir, HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });
  renameSync(imagePath, join(historyDir, archiveName(id, new Date())));
}

/**
 * v2 配图：逐镜头生成；风格锚先生成一次并在多镜头复用同一资产与 seed。
 * @returns 各镜头回填后的图片路径与本次生成的镜头 ID
 */
async function generateImagesV2(options: {
  doc: CopyDocV2;
  options: GenerateImagesOptions;
  projectDir: string;
  prompts: PromptSet;
  ark: ArkEndpoint;
  apiKey: string;
}): Promise<{ images: Array<string | undefined>; generated: string[] }> {
  const { doc, options: input, projectDir, prompts, ark, apiKey } = options;
  const imagesDir = join(projectDir, "images");
  const anchorsDir = join(imagesDir, "anchors");
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(anchorsDir, { recursive: true });

  const all = doc.scenes.flatMap((scene) =>
    scene.shots.map((shot) => ({ sceneId: scene.sceneId, shot })),
  );
  let scoped = all;
  if (input.shotIds && input.shotIds.length > 0) {
    const wanted = new Set(input.shotIds);
    const unknown = input.shotIds.filter((id) => !all.some((item) => item.shot.shotId === id));
    if (unknown.length > 0) {
      throw new VideoForgeError("CONFIG_INVALID", `未知的镜头 ID：${unknown.join(", ")}`);
    }
    scoped = all.filter((item) => wanted.has(item.shot.shotId));
  } else if (input.sceneIds && input.sceneIds.length > 0) {
    const sceneScope = new Set(
      resolveSceneScope(
        doc.scenes.map((scene) => scene.sceneId),
        input.sceneIds,
      ),
    );
    scoped = all.filter((item) => sceneScope.has(item.sceneId));
  }
  if (input.promptOverride !== undefined && scoped.length !== 1) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "promptOverride 只能配合单个 shotId 或 sceneId 使用，避免同一描述覆盖多个镜头",
    );
  }

  const usedAnchorKeys = new Set(scoped.flatMap((item) => item.shot.anchorKeys));
  const anchorByKey = new Map(doc.styleAnchors.map((anchor) => [anchor.key, anchor]));
  const unknownAnchors = [...usedAnchorKeys].filter((key) => !anchorByKey.has(key));
  if (unknownAnchors.length > 0) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `镜头引用了不存在的风格锚：${unknownAnchors.join(", ")}`,
    );
  }

  // 先生成被引用的风格锚：同一 key 全片只生成一次
  for (const key of usedAnchorKeys) {
    const anchor = anchorByKey.get(key)!;
    const relative = `images/anchors/${key}.png`;
    const absolute = join(projectDir, relative);
    const alreadyOnDisk = existsSync(absolute);
    if (!(input.mode === "missing" && alreadyOnDisk) && !(anchor.assetPath && existsSync(join(projectDir, anchor.assetPath)))) {
      const prompt = `固定符号「${anchor.label}」，主色 ${anchor.color}，简洁扁平插画，深色纯色背景。${prompts.imageSuffix}`;
      const seed = anchor.seed ?? stableSeed(`anchor:${key}`);
      const startedAt = Date.now();
      try {
        const buf = await arkGenerateImage({
          baseUrl: ark.base_url,
          apiKey,
          model: ark.image_model,
          prompt,
          size: "2K",
          seed,
        });
        archiveExistingImage(imagesDir, `anchor-${key}`, absolute);
        writeFileSync(absolute, buf);
        anchor.seed = seed;
        appendGenerationRecord(projectDir, {
          runId: input.runId,
          stage: "image",
          assetPath: relative,
          model: ark.image_model,
          promptSet: prompts.name,
          prompt,
          params: { size: "2K", kind: "style-anchor", anchorKey: key, seed },
          templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
          ok: true,
          contractVersion: "2.0",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        appendGenerationRecord(projectDir, {
          runId: input.runId,
          stage: "image",
          assetPath: relative,
          model: ark.image_model,
          promptSet: prompts.name,
          prompt,
          params: { size: "2K", kind: "style-anchor", anchorKey: key, seed },
          templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
          ok: false,
          errorCode: error instanceof VideoForgeError ? error.code : "ADAPTER_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
          contractVersion: "2.0",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    }
    anchor.assetPath = relative;
  }

  const generated: string[] = [];
  for (const { sceneId, shot } of scoped) {
    const relative = `images/${shot.shotId}.png`;
    const absolute = join(projectDir, relative);
    if (input.mode === "missing" && existsSync(absolute)) {
      shot.imagePath = relative;
      continue;
    }

    const anchors = shot.anchorKeys
      .map((key) => anchorByKey.get(key))
      .filter((anchor): anchor is StyleAnchor => Boolean(anchor));
    const symbolAnchor =
      shot.visualType === "symbol" && anchors.length === 1 ? anchors[0] : undefined;
    const reusablePath = symbolAnchor?.assetPath
      ? join(projectDir, symbolAnchor.assetPath)
      : undefined;

    if (reusablePath && existsSync(reusablePath)) {
      // 同一符号直接复用已生成资产，不再调用模型，保证跨镜头一致
      archiveExistingImage(imagesDir, shot.shotId, absolute);
      copyFileSync(reusablePath, absolute);
      shot.imagePath = relative;
      generated.push(shot.shotId);
      appendGenerationRecord(projectDir, {
        runId: input.runId,
        stage: "image",
        sceneId,
        shotId: shot.shotId,
        assetPath: relative,
        model: ark.image_model,
        promptSet: prompts.name,
        prompt: `复用风格锚 ${symbolAnchor!.key}：${symbolAnchor!.assetPath}`,
        params: { size: "2K", mode: input.mode ?? "all", reusedAnchor: symbolAnchor!.key },
        ok: true,
        contractVersion: "2.0",
      });
      continue;
    }

    const prompt = input.promptOverride ?? buildShotImagePrompt(shot, anchors, prompts.imageSuffix);
    const seed = stableSeed(`shot:${shot.shotId}:${shot.anchorKeys.join(",")}`);
    const startedAt = Date.now();
    try {
      const buf = await arkGenerateImage({
        baseUrl: ark.base_url,
        apiKey,
        model: ark.image_model,
        prompt,
        size: "2K",
        seed,
      });
      archiveExistingImage(imagesDir, shot.shotId, absolute);
      writeFileSync(absolute, buf);
      shot.imagePath = relative;
      generated.push(shot.shotId);
      appendGenerationRecord(projectDir, {
        runId: input.runId,
        stage: "image",
        sceneId,
        shotId: shot.shotId,
        assetPath: relative,
        model: ark.image_model,
        promptSet: prompts.name,
        prompt,
        params: {
          size: "2K",
          mode: input.mode ?? "all",
          overridden: input.promptOverride !== undefined,
          seed,
          anchorKeys: shot.anchorKeys,
        },
        templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
        ok: true,
        contractVersion: "2.0",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      appendGenerationRecord(projectDir, {
        runId: input.runId,
        stage: "image",
        sceneId,
        shotId: shot.shotId,
        assetPath: relative,
        model: ark.image_model,
        promptSet: prompts.name,
        prompt,
        params: { size: "2K", mode: input.mode ?? "all", seed },
        templateSnapshot: { "image-suffix.txt": prompts.imageSuffix },
        ok: false,
        errorCode: error instanceof VideoForgeError ? error.code : "ADAPTER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        contractVersion: "2.0",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  writeCopyDocV2(input.outFile ?? input.copyPath, doc);
  return { images: all.map((item) => item.shot.imagePath), generated };
}

/**
 * image:gen 阶段能力：逐场景（v1）或逐镜头（v2）调用 Ark 文生图并回填 copy.json。
 * - v1：每个 scene 一张图，行为与旧版完全一致；
 * - v2：每个 shot 一张图，风格锚先生成一次并在多镜头复用同一资产与 seed；
 * - 底图无文字约束后缀来自提示词集 image-suffix.txt；
 * - 定向重生成前把旧图归档到 `images/history/`，并写 `manifest/generations.jsonl`。
 * @param options 运行参数
 * @returns 回填后的图片路径与本轮实际生成的场景/镜头 ID
 */
export async function generateImages(
  options: GenerateImagesOptions,
): Promise<{ images: Array<string | undefined>; generated: string[] }> {
  const document = readCopyDocument(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  const prompts = resolvePrompts(options.rootDir, options.promptSet, config);
  const projectDir = dirname(options.copyPath);
  const imagesDir = join(projectDir, "images");

  if (document.version === "2") {
    return generateImagesV2({
      doc: document.doc,
      options,
      projectDir,
      prompts,
      ark,
      apiKey,
    });
  }

  const doc: CopyDoc = document.doc;
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
      archiveExistingImage(imagesDir, sceneId, imagePath);
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
        contractVersion: "1.0",
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
        contractVersion: "1.0",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { images: doc.scenes.map((s) => s.imagePath), generated };
}
