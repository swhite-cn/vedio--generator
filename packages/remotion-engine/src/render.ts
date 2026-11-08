import { mkdir } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderFrames, renderStill, selectComposition } from "@remotion/renderer";
import type { ShotSpec, ThemeV2, TimelineDocV2 } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { buildShotFramePlan, selectShotPlans } from "./frames.js";
import { SHOTS_COMPOSITION_ID } from "./entry.js";

/**
 * 镜头级渲染入口（T201 骨架，方案 §4.2 渲染层）。
 * - 一次 bundle，多镜头复用；按镜头分目录输出帧序列（compose 层用 ffmpeg 合成）；
 * - `shotIds` 支持镜头级重渲：只渲染目标镜头，其余镜头产物不动；
 * - 浏览器实例由 @remotion/renderer 内部管理，这里只透传 `browserExecutable`
 *   （可复用本机 Chrome，避免强制下载 chrome-headless-shell）。
 */

/** renderShots 的输入。 */
export interface RenderShotsInput {
  /** Remotion bundle 入口（entry.tsx 绝对路径）。 */
  entryPoint: string;
  /** timeline v2（切点权威来源）。 */
  timeline: TimelineDocV2;
  /** 主题（建议传项目快照内的冻结主题）。 */
  theme: ThemeV2;
  /** SceneSpec 镜头规格；scene 未跑时为空。 */
  specShots?: ShotSpec[] | null;
  /** 帧输出根目录；每个镜头输出到 `<outputDir>/<shotId>/`。 */
  outputDir: string;
  /** 目标镜头 ID；缺省渲染全部镜头。 */
  shotIds?: string[] | null;
  /**
   * 静态资产目录（bundle 时复制进产物根，Windows 恒复制）；
   * `imageByShot` 中的相对路径以此目录为根。缺省不挂载静态资产。
   */
  publicDir?: string | null;
  /** 镜头 ID → publicDir 内的图片相对路径（POSIX）；image 视觉层消费，缺省无映射。 */
  imageByShot?: Record<string, string> | null;
  /** 帧图片格式，默认 jpeg。 */
  imageFormat?: "jpeg" | "png";
  /** jpeg 质量 0–100，默认 90。 */
  jpegQuality?: number;
  /** 本机浏览器可执行文件；缺省由 remotion 解析或下载。 */
  browserExecutable?: string;
  /** 并发 page 数；缺省由 remotion 决定（约 CPU 一半）。 */
  concurrency?: number | null;
  /** 进度回调（已渲染帧数 / 总帧数）。 */
  onProgress?: (rendered: number, total: number) => void;
}

/** renderShots 的输出。 */
export interface RenderShotsResult {
  /** 实际渲染的镜头帧计划（按时间轴顺序）。 */
  entries: ReturnType<typeof buildShotFramePlan>;
  /** 渲染总帧数。 */
  totalFrames: number;
  /** bundle 产物地址（本地临时目录，remotion 自身管理缓存）。 */
  serveUrl: string;
}

/** 组装 Composition 的可序列化输入（render/renderStill 共用）。 */
function buildInputProps(input: {
  timeline: TimelineDocV2;
  theme: ThemeV2;
  specShots?: ShotSpec[] | null;
  shotIds?: string[] | null;
  imageByShot?: Record<string, string> | null;
}) {
  return {
    fps: input.timeline.fps,
    theme: input.theme,
    timeline: input.timeline,
    specShots: input.specShots ?? null,
    shotIds: input.shotIds ?? null,
    imageByShot: input.imageByShot ?? null,
  };
}

/**
 * bundle 入口并应用浏览器打包适配。
 * 仓库 TS 源码用 `.js` 后缀相对导入（NodeNext 约定，实际指向 .tsx/.ts 源），
 * Remotion 内置 webpack 默认不解析该映射，必须配置 extensionAlias；
 * 同时把 node: 内置模块置空——渲染链路（组件注册表校验）不触发文件读取，
 * 真正的文件读取（fixture/资产）发生在 bundle 之前的服务端。
 * @param entryPoint entry.tsx 绝对路径
 * @param publicDir 静态资产目录（bundle 时复制进产物根）；缺省不挂载
 * @returns bundle 后的 serveUrl
 */
async function bundleEntryPoint(entryPoint: string, publicDir?: string | null): Promise<string> {
  return bundle({
    entryPoint,
    publicDir: publicDir ?? null,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: {
          ".js": [".tsx", ".ts", ".js"],
          ".mjs": [".mts", ".mjs"],
        },
        alias: {
          ...(config.resolve?.alias ?? {}),
          "node:fs": false,
          "node:path": false,
          "node:url": false,
          "node:module": false,
        },
      },
    }),
  });
}

/**
 * 渲染目标镜头的帧序列。
 * @param input 渲染输入
 * @returns 渲染结果
 * @throws VideoForgeError(`TOOL_UNAVAILABLE`) bundle 或渲染失败
 * @throws VideoForgeError(`CONFIG_INVALID`) 目标镜头不在时间轴内
 */
export async function renderShots(input: RenderShotsInput): Promise<RenderShotsResult> {
  const imageFormat = input.imageFormat ?? "jpeg";
  const plans = selectShotPlans(buildShotFramePlan(input.timeline), input.shotIds ?? undefined);
  if (plans.length === 0) {
    throw new VideoForgeError("CONFIG_INVALID", "没有可渲染的镜头（shotIds 未命中时间轴）");
  }

  const inputProps = buildInputProps(input);

  let serveUrl: string;
  try {
    serveUrl = await bundleEntryPoint(input.entryPoint, input.publicDir);
  } catch (err) {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion bundle 失败：${(err as Error).message}`);
  }

  // 只 selectComposition 一次（元数据由 calculateShotsMetadata 按输入动态计算）
  const composition = await selectComposition({
    serveUrl,
    id: SHOTS_COMPOSITION_ID,
    inputProps,
  }).catch((err: Error) => {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion composition 解析失败：${err.message}`);
  });

  const totalFrames = plans.reduce((sum, plan) => sum + plan.durationInFrames, 0);
  let renderedFrames = 0;
  const report = (): void => {
    renderedFrames += 1;
    input.onProgress?.(renderedFrames, totalFrames);
  };

  try {
    for (const plan of plans) {
      const shotDir = `${input.outputDir}/${plan.shotId}`;
      await mkdir(shotDir, { recursive: true });
      await renderFrames({
        composition,
        serveUrl,
        inputProps,
        outputDir: shotDir,
        imageFormat,
        jpegQuality: input.jpegQuality ?? 90,
        frameRange: [plan.fromFrame, plan.fromFrame + plan.durationInFrames - 1],
        browserExecutable: input.browserExecutable,
        concurrency: input.concurrency ?? null,
        onStart: () => undefined,
        onFrameUpdate: () => report(),
      });
    }
  } catch (err) {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion 渲染失败：${(err as Error).message}`);
  }

  return { entries: plans, totalFrames, serveUrl };
}

/** renderShotStill 的输入（单帧，镜头预览/质检采样用）。 */
export interface RenderShotStillInput {
  /** Remotion bundle 入口（entry.tsx 绝对路径）。 */
  entryPoint: string;
  /** timeline v2。 */
  timeline: TimelineDocV2;
  /** 主题。 */
  theme: ThemeV2;
  /** SceneSpec 镜头规格。 */
  specShots?: ShotSpec[] | null;
  /** 目标镜头 ID。 */
  shotId: string;
  /** 镜头内偏移帧（0 = 镜头首帧），默认 0。 */
  offsetFrame?: number;
  /** 输出图片绝对路径。 */
  output: string;
  /** 静态资产目录（bundle 时挂载）；与 `imageByShot` 配套。 */
  publicDir?: string | null;
  /** 镜头 ID → publicDir 内图片相对路径；image 视觉层消费。 */
  imageByShot?: Record<string, string> | null;
  /** 图片格式，默认 png。 */
  imageFormat?: "jpeg" | "png";
  /** 本机浏览器可执行文件。 */
  browserExecutable?: string;
}

/**
 * 渲染单个镜头的某一帧（镜头预览、质检静帧采样）。
 * @param input 单帧渲染输入
 * @throws VideoForgeError(`CONFIG_INVALID`) 目标镜头不存在或偏移越界
 * @throws VideoForgeError(`TOOL_UNAVAILABLE`) bundle/渲染失败
 */
export async function renderShotStill(input: RenderShotStillInput): Promise<void> {
  const plans = buildShotFramePlan(input.timeline);
  const plan = plans.find((entry) => entry.shotId === input.shotId);
  if (!plan) {
    throw new VideoForgeError("CONFIG_INVALID", `镜头不在时间轴内：${input.shotId}`);
  }
  const offset = input.offsetFrame ?? 0;
  if (offset < 0 || offset >= plan.durationInFrames) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `镜头 ${input.shotId} 帧偏移越界：${offset}/${plan.durationInFrames}`,
    );
  }

  const inputProps = buildInputProps({ ...input, shotIds: [input.shotId] });

  let serveUrl: string;
  try {
    serveUrl = await bundleEntryPoint(input.entryPoint, input.publicDir);
  } catch (err) {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion bundle 失败：${(err as Error).message}`);
  }

  const composition = await selectComposition({
    serveUrl,
    id: SHOTS_COMPOSITION_ID,
    inputProps,
  }).catch((err: Error) => {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion composition 解析失败：${err.message}`);
  });

  try {
    await renderStill({
      composition,
      serveUrl,
      inputProps,
      output: input.output,
      frame: plan.fromFrame + offset,
      imageFormat: input.imageFormat ?? "png",
      browserExecutable: input.browserExecutable,
      overwrite: true,
    });
  } catch (err) {
    throw new VideoForgeError("TOOL_UNAVAILABLE", `Remotion 单帧渲染失败：${(err as Error).message}`);
  }
}
