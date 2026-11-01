import { z } from "zod";
import { VideoForgeError } from "@videoforge/shared";
import type { SceneData } from "./contracts.js";

/**
 * LLM 动画场景代码契约：body 内部 HTML、CSS 与挂在已暂停 GSAP 时间轴上的 JS。
 * 渲染器只认注册到 window.__videoforgeTimeline 的时间轴，按进度寻帧。
 */
export const sceneCodeSchema = z.object({
  html: z.string().min(1).max(20_000),
  css: z.string().max(20_000).default(""),
  js: z.string().min(1).max(20_000),
});

export type SceneCode = z.infer<typeof sceneCodeSchema>;

/** 会破坏封闭脚本/style 标签或引入非确定性、外部依赖的模式 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /https?:\/\//i, reason: "包含外部 URL（场景必须完全离线自包含）" },
  { pattern: /<\/script/i, reason: "包含 </script>（会截断包装文档）" },
  { pattern: /<\/style/i, reason: "包含 </style>（会截断包装文档）" },
  {
    pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/,
    reason: "禁止使用定时器（动画必须挂在 tl 时间轴上）",
  },
  {
    pattern: /\brequestAnimationFrame\s*\(/,
    reason: "禁止使用 requestAnimationFrame（渲染按帧寻址）",
  },
  { pattern: /\bDate\.now\s*\(|\bnew\s+Date\b/, reason: "禁止使用真实时钟（渲染必须确定性）" },
  { pattern: /\bMath\.random\s*\(/, reason: "禁止使用随机数（渲染必须确定性）" },
  { pattern: /\bfetch\s*\(|\bXMLHttpRequest\b/, reason: "禁止网络请求（场景必须离线自包含）" },
];

/**
 * 校验场景代码的安全性与确定性约束；违反时抛 ADAPTER_PROTOCOL_INVALID。
 * @param code LLM 输出的场景代码
 */
export function assertSceneCodeSafe(code: SceneCode): void {
  const combined = `${code.html}\n${code.css}\n${code.js}`;
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(combined)) {
      throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", `场景代码非法：${reason}`);
    }
  }
}

/**
 * 把场景代码包装为完整 HTML 文档：注入本地 GSAP（相对路径 ../vendor/gsap.min.js），
 * 并保证时间轴以 paused 创建后注册到 window.__videoforgeTimeline，供渲染器逐帧 seek。
 * @param code 场景代码
 * @param options 画布尺寸
 * @returns 可落盘的完整 HTML 文档
 */
export function wrapSceneDocument(
  code: SceneCode,
  options: { width: number; height: number },
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${options.width}px;height:${options.height}px;overflow:hidden;background:#0b1020;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif}</style>
<style>
${code.css}
</style>
</head>
<body>
${code.html}
<script src="../vendor/gsap.min.js"></script>
<script>
(function () {
  var tl = gsap.timeline({ paused: true });
  (function (tl) {
${code.js}
  })(tl);
  window.__videoforgeTimeline = tl;
})();
</script>
</body>
</html>
`;
}

/** HTML 转义，用于把标题/口播等文本嵌入降级模板 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 生成确定性的降级动画场景（LLM 输出不可用时使用）：
 * Ken Burns 推拉底图 + 标题滑入 + 底部字幕条，时间轴固定 10s（渲染器按进度归一化寻帧）。
 * @param scene 场景数据
 * @param imageRelPath 场景图相对路径（scenes/ 目录视角），为空时用渐变背景
 * @returns 通过安全校验的场景代码
 */
export function buildFallbackSceneCode(
  scene: SceneData,
  imageRelPath: string | undefined,
): SceneCode {
  const title = escapeHtml(scene.title);
  const narration = escapeHtml(scene.narration);
  // 依据 sceneId 交替推拉方向，避免所有场景动效雷同
  const direction = scene.sceneId.length % 2 === 0 ? 1 : -1;
  const background = imageRelPath
    ? `<img class="bg" src="${imageRelPath}" alt="">`
    : `<div class="bg gradient"></div>`;
  const html = [
    background,
    `<div class="scrim"></div>`,
    `<div class="title-wrap"><div class="accent"></div><h1 class="title">${title}</h1></div>`,
    `<div class="caption"><p>${narration}</p></div>`,
  ].join("\n");
  const css = `
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bg.gradient{background:linear-gradient(135deg,#0f2027,#203a43,#2c5364)}
.scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,10,20,0.55) 0%,rgba(5,10,20,0.15) 45%,rgba(5,10,20,0.75) 100%)}
.title-wrap{position:absolute;top:72px;left:96px;right:96px;display:flex;align-items:center;gap:24px}
.accent{width:12px;height:88px;background:#38bdf8;border-radius:6px;flex:none}
.title{font-size:72px;font-weight:700;color:#fff;margin:0;text-shadow:0 4px 24px rgba(0,0,0,0.6)}
.caption{position:absolute;left:96px;right:96px;bottom:72px;background:rgba(8,14,28,0.72);border:1px solid rgba(56,189,248,0.35);border-radius:16px;padding:28px 36px}
.caption p{margin:0;font-size:40px;line-height:1.6;color:#e8f2ff}
`;
  const js = [
    `tl.fromTo(".bg", { scale: 1.12, xPercent: ${-2 * direction} }, { scale: 1.22, xPercent: ${2 * direction}, duration: 10, ease: "none" }, 0);`,
    `tl.from(".accent", { scaleY: 0, transformOrigin: "top", duration: 0.5, ease: "power2.out" }, 0.3);`,
    `tl.from(".title", { opacity: 0, y: 48, duration: 0.8, ease: "power3.out" }, 0.5);`,
    `tl.from(".caption", { opacity: 0, y: 32, duration: 0.7, ease: "power2.out" }, 1.0);`,
  ].join("\n");
  return { html, css, js };
}
