import { pathToFileURL } from "node:url";
import { getProfile, type SceneContext, type SceneData } from "./contracts.js";

/**
 * 把本地图片绝对路径转为 file:// URL（自动处理 Windows 盘符、空格与中文）。
 */
function toImageUrl(imagePath: string): string {
  return pathToFileURL(imagePath).href;
}

/**
 * 渲染场景底图；优先使用 data: URL（绕过 about:blank 对 file:// 子资源的拦截），
 * 否则把本地图片绝对路径转为 file:// URL；二者皆空时返回空串。
 */
function renderSceneImage(scene: SceneData, width: number, height: number): string {
  const src = scene.imageDataUrl ?? (scene.imagePath ? toImageUrl(scene.imagePath) : "");
  if (!src) return "";
  return `<img src="${src}" alt="" style="position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:cover;"/>`;
}

/**
 * 生成确定性的最小场景 HTML，不读取系统时间或随机数。
 * @param context 场景上下文
 * @returns 可注入 stage.html 的 HTML 片段
 */
export function renderMinimalScene(context: SceneContext): string {
  const progress = Math.max(0, Math.min(1, context.timeMs / 10_000));
  const padding = context.profile === "PORTRAIT_1080P" ? "96px" : "120px";
  const spec = getProfile(context.profile);
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  // 有底图时给文字区加半透明底色，保证文字可读性
  const hasImage = Boolean(context.scene.imageDataUrl ?? context.scene.imagePath);
  const textBg = hasImage ? "background:rgba(16,24,39,0.55);" : "";
  return `<main style="padding:${padding};font-family:Arial,sans-serif;color:#fff;background:#101827;width:100%;height:100%;box-sizing:border-box;position:relative">
    ${renderSceneImage(context.scene, spec.width, spec.height)}
    <div style="position:relative;${textBg}">
      <h1>${escape(context.scene.title)}</h1>
      <p>${escape(context.scene.narration)}</p>
    </div>
    <div style="position:absolute;left:${padding};right:${padding};bottom:${padding};height:12px;background:#334155">
      <div style="height:100%;width:${progress * 100}%;background:#38bdf8"></div>
    </div>
  </main>`;
}
