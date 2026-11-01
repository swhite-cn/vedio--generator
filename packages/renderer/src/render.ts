import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { VideoForgeError } from "@videoforge/shared";
import { renderMinimalScene, type ProfileSpec, type SceneData } from "@videoforge/template-sdk";

/** 场景 HTML 必须注册的全局时间轴句柄名（见 scene-contract.ts 包装器） */
const TIMELINE_HANDLE = "__videoforgeTimeline";

/**
 * 帧截图格式与质量：JPEG 无透明通道但视频帧本不需要，
 * 相比 PNG 编码与 CDP 回传开销降低约 3-4 倍（实测单帧 460ms→120ms 量级），quality 92 肉眼无损。
 */
const FRAME_EXT = "jpg";
const FRAME_JPEG_QUALITY = 92;

/** 按时长与帧率计算场景应渲染的帧数（至少 1 帧，向上取整保证覆盖尾帧） */
export function sceneFrameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

/**
 * 读取底图并转为 data: URL；文件缺失时抛 ADAPTER_PROTOCOL_INVALID。
 * about:blank 文档加载 file:// 子资源会被 Chromium 拦截，故回退路径一律内联图片。
 */
async function toImageDataUrl(imagePath: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await readFile(imagePath);
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `场景图片读取失败：${imagePath}（${(err as Error).message}）`,
    );
  }
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/**
 * 在复用的页面上渲染单个场景的帧序列（帧号全局连续）。
 * 场景含 htmlPath 时走 GSAP 时间轴寻帧（file:// 文档可正常加载本地图片与 vendor GSAP）；
 * 否则回退最小模板（底图内联为 data: URL）。任一方式均按帧确定性寻址，不依赖真实时钟。
 * @param options 渲染参数
 * @returns 本场景实际写入的帧数
 */
export async function renderSceneFrames(options: {
  page: Page;
  scene: SceneData;
  durationMs: number;
  spec: ProfileSpec;
  framesDir: string;
  firstFrame: number;
}): Promise<number> {
  const { page, scene, spec } = options;
  const frameCount = sceneFrameCount(options.durationMs, spec.fps);
  const framePath = (index: number) =>
    `${options.framesDir}/${String(options.firstFrame + index).padStart(8, "0")}.${FRAME_EXT}`;
  /** 逐帧截图：JPEG 编码 + 显式 quality，避免 PNG 的大位图编码与回传开销 */
  const capture = (index: number) =>
    page.screenshot({ path: framePath(index), type: "jpeg", quality: FRAME_JPEG_QUALITY });

  if (scene.htmlPath) {
    await page.goto(pathToFileURL(scene.htmlPath).href);
    const handle = await page
      .waitForFunction(
        (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
        TIMELINE_HANDLE,
        { timeout: 15_000 },
      )
      .catch(() => null);
    if (!handle) {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `场景 ${scene.sceneId} 的动画 HTML 未注册 ${TIMELINE_HANDLE}：${scene.htmlPath}，请重跑 scene:gen`,
      );
    }
    const timelineDuration = await page.evaluate(
      (name) => (window as unknown as Record<string, { duration(): number }>)[name].duration(),
      TIMELINE_HANDLE,
    );
    if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `场景 ${scene.sceneId} 的动画时间轴时长非法（${timelineDuration}），请重跑 scene:gen`,
      );
    }
    for (let index = 0; index < frameCount; index += 1) {
      const progress = Math.min(1, ((index / spec.fps) * 1000) / options.durationMs);
      // suppressEvents=true：寻帧不触发回调，保证纯函数式渲染
      // 注意：必须用块体函数避免隐式返回 timeline 实例——
      // seek 返回值含循环引用，Playwright 序列化结果时会永久挂起
      await page.evaluate(
        ({ name, time }) => {
          (window as unknown as Record<string, { seek(t: number, s: boolean): void }>)[name].seek(
            time,
            true,
          );
        },
        { name: TIMELINE_HANDLE, time: progress * timelineDuration },
      );
      await capture(index);
    }
    console.info(`[render] scene ${scene.sceneId}: ${frameCount} frames (gsap)`);
    return frameCount;
  }

  // 回退路径：最小模板 + data: URL 底图
  const fallbackScene: SceneData = {
    ...scene,
    imageDataUrl:
      scene.imageDataUrl ?? (scene.imagePath ? await toImageDataUrl(scene.imagePath) : undefined),
  };
  const stage = await readFile(new URL("./stage.html", import.meta.url), "utf8");
  await page.goto("about:blank");
  await page.setContent(stage, { waitUntil: "load" });
  for (let index = 0; index < frameCount; index += 1) {
    const timeMs = (index / spec.fps) * 1000;
    const html = renderMinimalScene({ scene: fallbackScene, profile: spec.profile, timeMs });
    await page.locator("#scene").evaluate((element, value) => {
      element.innerHTML = value;
    }, html);
    await capture(index);
  }
  console.info(`[render] scene ${scene.sceneId}: ${frameCount} frames (fallback)`);
  return frameCount;
}
