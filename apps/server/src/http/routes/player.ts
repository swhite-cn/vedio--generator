import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ShotsCompositionProps } from "@videoforge/remotion-engine";
import { prepareShotRenderInput } from "../../domain/render-input.js";
import { VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";

/**
 * Player iframe 入口路由（T208，方案 §7.1/§8.9）。
 * `GET /api/player/:projectId/:shotId?` 动态渲染 HTML：鉴权后把渲染输入内联到
 * `window.__PLAYER_DATA__`，脚本引用静态 bundle `/player/player.js`（vite lib 构建）。
 * 数据组装失败（v1 项目 / 产物缺失）时内联 error 字段——Player 展示错误态，不白屏。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */

/**
 * 把对象序列化为可安全内联 `<script>` 的 JSON 文本。
 * 转义 `<`/U+2028/U+2029，避免 `</script>` 闭合与 JS 语法破坏（同源数据，仍按惯例转义）。
 * @param value 待序列化对象
 * @returns 安全的 JSON 文本
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** 渲染数据到 Composition inputProps 的最小结构（服务端只透传，不推导）。 */
type PlayerInlineProps = Pick<
  ShotsCompositionProps,
  "timeline" | "theme" | "specShots" | "imageByShot"
>;

/** 组装内联 HTML（数据 + bundle 引用 + 失败兜底文案）。 */
function renderPlayerHtml(projectId: string, data: unknown): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>VideoForge 预览</title>
<style>html,body,#root{margin:0;padding:0;width:100%;height:100%;background:#101216}</style>
</head>
<body>
<noscript>预览播放器需要启用 JavaScript。</noscript>
<div id="root"></div>
<script>window.__PLAYER_DATA__=${inlineJson(data)};window.__PLAYER_PROJECT__=${inlineJson(projectId)};</script>
<script src="/player/player.js"></script>
</body>
</html>`;
}

/**
 * 注册 Player iframe 入口。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerPlayerRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.get(
    "/api/player/:projectId/:shotId?",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const { projectId, shotId } = request.params as { projectId: string; shotId?: string };
      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }
      const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);

      // 数据组装失败不 500：内联 error 让 Player 显示错误态（不白屏）
      let data: Record<string, unknown>;
      try {
        const input = prepareShotRenderInput(projectDir);
        const props: PlayerInlineProps = {
          timeline: input.timeline,
          theme: input.theme,
          specShots: input.specShots,
          imageByShot: input.imageByShot,
        };
        data = {
          projectId: project.id,
          shotId: shotId ?? null,
          ...props,
        };
      } catch (error) {
        const code = error instanceof VideoForgeError ? error.code : "PLAYER_DATA_FAILED";
        const message = error instanceof Error ? error.message : String(error);
        data = {
          projectId: project.id,
          shotId: shotId ?? null,
          timeline: null,
          theme: null,
          specShots: null,
          imageByShot: null,
          error: { code, message },
        };
      }

      reply.code(200).header("content-type", "text/html; charset=utf-8");
      return renderPlayerHtml(project.id, data);
    },
  );
}
