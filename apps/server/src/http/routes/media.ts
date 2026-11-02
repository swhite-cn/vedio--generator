import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import { assertInsideUserRoot } from "@videoforge/pipeline";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, extractActor, requireActor } from "../auth-hook.js";
import { NOT_FOUND_CODE } from "../errors.js";
import {
  MEDIA_COOKIE_NAME,
  MEDIA_TICKET_TTL_MS,
  signMediaTicket,
  verifyMediaTicket,
} from "../media-ticket.js";

/**
 * 受限媒体读取路由（见设计文档 §4.2 `/api/media/*`、§8.3 媒体层）。
 * 只接受 `users/<当前 userId>/...` 形式的相对路径（POSIX `/` 分隔），先校验归属再读文件；
 * admin 也只读自己的媒体（全站分析走 trace 表，不走媒体层）。
 * 响应体绝不包含绝对路径；仅日志记录相对路径。
 *
 * 鉴权：浏览器原生标签（img / audio / video / 新标签页）无法带 `Authorization`，
 * 因此额外接受 `?ticket=`（媒体票据）与 `vf_media` Cookie；API 调用仍可用 Bearer。
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
 * 为工作台场景预览注入自动播放脚本。
 * 正常渲染路径不带 `preview=1`，仍保持场景时间轴暂停以供逐帧 seek。
 * @param html 已落盘的场景 HTML
 * @returns 可在浏览器中从头播放的预览 HTML
 */
function injectScenePreviewPlayback(html: string): string {
  const playback = `<script>
(function () {
  /** 立即播放已注册的场景时间轴；时间轴缺失时返回 false，交由 load 兜底。 */
  function playScene() {
    var timeline = window.__videoforgeTimeline;
    if (!timeline) return false;
    if (typeof timeline.restart === "function") { timeline.restart(); return true; }
    if (typeof timeline.play === "function") { timeline.play(0); return true; }
    return false;
  }
  /** 首帧解析完成即尝试播放；仍失败则等 load 事件再试一次。 */
  function boot() {
    if (playScene()) return;
    console.warn("[videoforge] 场景时间轴未就绪，请确认项目 vendor/gsap.min.js 存在");
  }
  boot();
  window.addEventListener("load", boot, { once: true });
})();
</script>`;
  return html.includes("</body>")
    ? html.replace("</body>", `${playback}</body>`)
    : `${html}${playback}`;
}

/**
 * 从 Cookie 头中取出指定 Cookie 的值（不引第三方 cookie 插件）。
 * @param header 原始 `Cookie` 头，缺省为 undefined
 * @param name Cookie 名
 * @returns 解码后的值；不存在时返回 null
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      if (value.length === 0) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        // 畸形编码按缺失处理，交由后续鉴权返回 401，而不是 500
        return null;
      }
    }
  }
  return null;
}

/** 单段 Range 的解析结果：`{ start, end }` 可满足；`"unsatisfiable"` 需回 416；`null` 忽略 Range。 */
type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * 解析单段 `Range` 请求头（视频播放 / 拖动进度条依赖 206）。
 * 只支持 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；多段等复杂语法忽略并回退 200。
 * @param header 原始 Range 头
 * @param size 文件总字节数
 * @returns 可满足区间、`"unsatisfiable"` 或 `null`（忽略）
 */
function parseByteRange(header: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (size <= 0) return "unsatisfiable";

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 解析媒体请求的主体：优先 Bearer，其次 `?ticket=`，最后 `vf_media` Cookie。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param request Fastify 请求
 * @returns 已鉴权 actor
 * @throws VideoForgeError(`AUTH_INVALID`) 三种凭据均缺失或无效
 */
function resolveMediaActor(app: FastifyInstance, request: FastifyRequest): Actor {
  if (request.headers.authorization) {
    return extractActor(app, request.headers.authorization);
  }
  const query = (request.query ?? {}) as Record<string, unknown>;
  const queryTicket = typeof query.ticket === "string" ? query.ticket : "";
  if (queryTicket.length > 0) {
    return verifyMediaTicket(app, queryTicket);
  }
  const cookieTicket = readCookie(request.headers.cookie, MEDIA_COOKIE_NAME);
  if (cookieTicket) {
    return verifyMediaTicket(app, cookieTicket);
  }
  throw new VideoForgeError("AUTH_INVALID", "缺少凭据");
}

/**
 * 注册媒体读取路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerMediaRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 签发媒体短时票据：供 img / audio / video / 新标签页打开场景使用。 */
  app.post("/api/media/ticket", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    reply.code(200);
    return { ticket: signMediaTicket(app, actor), expiresInMs: MEDIA_TICKET_TTL_MS };
  });

  /**
   * 读取本人媒体文件：先做文件层归属校验（禁止目录逃逸与跨用户），再前缀校验，
   * 最后按扩展名返回（带 Range/206 支持）。越界 / 跨用户抛 `PATH_OUTSIDE_STORAGE`(403)；
   * 文件缺失返回 404 `NOT_FOUND`。
   */
  app.get("/api/media/*", async (request, reply) => {
    const actor = resolveMediaActor(app, request);
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

    // 用 ?ticket= 访问时补一个 Cookie：场景 HTML 内的相对资源（图片 / gsap）子请求没有查询串，
    // 只能靠 Cookie 鉴权；Path 限定在 /api/media，避免扩散到其它接口。
    const query = (request.query ?? {}) as Record<string, unknown>;
    const queryTicket = typeof query.ticket === "string" ? query.ticket : "";
    const preview = query.preview === "1";
    if (!request.headers.authorization && queryTicket.length > 0) {
      reply.header(
        "Set-Cookie",
        `${MEDIA_COOKIE_NAME}=${encodeURIComponent(queryTicket)}; Path=/api/media; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(MEDIA_TICKET_TTL_MS / 1000)}`,
      );
    }

    // 仅记录相对路径，绝不把绝对路径写入日志或响应体
    app.log.info({ relative }, "[http] 读取媒体文件");

    const stat = statSync(target);
    const type = contentTypeFor(extname(target));
    // 场景预览只在显式 query 下转为自动播放 HTML；渲染器读取原文件不受影响。
    if (preview && extname(target).toLowerCase() === ".html") {
      const html = readFileSync(target, "utf-8");
      return reply.code(200).type(type).send(injectScenePreviewPlayback(html));
    }
    const range =
      typeof request.headers.range === "string"
        ? parseByteRange(request.headers.range, stat.size)
        : null;

    if (range === "unsatisfiable") {
      return reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
    }
    if (range) {
      return reply
        .code(206)
        .headers({
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
          "Content-Length": range.end - range.start + 1,
        })
        .type(type)
        .send(createReadStream(target, { start: range.start, end: range.end }));
    }
    return reply
      .code(200)
      .headers({ "Accept-Ranges": "bytes", "Content-Length": stat.size })
      .type(type)
      .send(createReadStream(target));
  });
}
