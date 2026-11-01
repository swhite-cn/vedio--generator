import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { VideoForgeError } from "@videoforge/shared";
import { assertInsideUserRoot } from "@videoforge/pipeline";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { NOT_FOUND_CODE } from "../errors.js";

/**
 * 受限媒体读取路由（见设计文档 §4.2 `/api/media/*`、§8.3 媒体层）。
 * 只接受 `users/<当前 userId>/...` 形式的相对路径（POSIX `/` 分隔），先校验归属再读文件；
 * admin 也只读自己的媒体（全站分析走 trace 表，不走媒体层）。
 * 响应体绝不包含绝对路径；仅日志记录相对路径。
 */

/** 扩展名 → Content-Type 映射；未命中回落 `application/octet-stream`。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 按文件扩展名解析 Content-Type（大小写不敏感）。
 * @param ext 含点号的扩展名（如 `.png`）
 * @returns 命中的 MIME 类型，未命中返回 `application/octet-stream`
 */
function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * 注册媒体读取路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerMediaRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /**
   * 读取本人媒体文件：先做文件层归属校验（禁止目录逃逸与跨用户），再前缀校验，
   * 最后按扩展名流式返回。越界 / 跨用户抛 `PATH_OUTSIDE_STORAGE`(403)；文件缺失返回 404 `NOT_FOUND`。
   */
  app.get("/api/media/*", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const relative = (request.params as Record<string, string>)["*"] ?? "";
    if (relative.length === 0) {
      throw new VideoForgeError("PATH_OUTSIDE_STORAGE", "媒体路径为空");
    }

    // 文件层归属：目标必须落在当前用户根目录内（拒绝 ../ 逃逸与其它用户目录）
    const userRoot = resolve(deps.storageRoot, "users", actor.userId);
    const target = resolve(deps.storageRoot, relative);
    assertInsideUserRoot(userRoot, target);

    // 媒体层前缀：相对路径必须以 users/<当前 userId>/ 开头（POSIX `/` 分隔）
    const expectedPrefix = `users/${actor.userId}/`;
    if (!relative.startsWith(expectedPrefix)) {
      throw new VideoForgeError("PATH_OUTSIDE_STORAGE", "媒体路径不属于当前用户");
    }

    if (!existsSync(target) || !statSync(target).isFile()) {
      return reply.code(404).send({ error: { code: NOT_FOUND_CODE, message: "媒体文件不存在" } });
    }

    // 仅记录相对路径，绝不把绝对路径写入日志或响应体
    app.log.info({ relative }, "[http] 读取媒体文件");
    return reply
      .code(200)
      .type(contentTypeFor(extname(target)))
      .send(createReadStream(target));
  });
}
