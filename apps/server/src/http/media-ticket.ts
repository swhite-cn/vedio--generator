import type { FastifyInstance } from "fastify";
import { VideoForgeError, type Actor, type UserRole } from "@videoforge/shared";

/**
 * 媒体短时票据（与 `event-ticket.ts` 同一设计思路，见设计文档 §8.1「token 不得出现在 URL」）。
 *
 * 背景：`<img>` / `<audio>` / `<video>` / `<a target="_blank">` 无法携带 `Authorization` 头，
 * 若媒体路由只接受 Bearer，浏览器原生加载一律 401。故为媒体单独签发用途受限的短时票据：
 * - 载荷 `{ scope: "media", uid, urole }`，有效期 `MEDIA_TICKET_TTL_MS`；
 * - 与 access token / SSE 票据互不通用（`auth-hook` 拒绝带 `scope` 的令牌，这里也校验 scope）；
 * - 只证明「是谁」，具体文件归属仍由媒体路由的 `users/<uid>/` 前缀校验兜底。
 *
 * 票据可放在 `?ticket=`（图片 / 音频 / 视频 / 新标签页打开场景）或 `vf_media` Cookie
 * （场景 HTML 内部的相对资源子请求会自动携带）。
 */

/** 媒体票据有效期（毫秒）：覆盖页面停留与视频播放期间的多次 Range 请求。 */
export const MEDIA_TICKET_TTL_MS = 30 * 60 * 1000;

/** 票据用途声明，防止与 access token、SSE 票据混用。 */
export const MEDIA_TICKET_SCOPE = "media";

/** 场景 HTML 子资源鉴权用的 Cookie 名（Path 限定在 `/api/media`）。 */
export const MEDIA_COOKIE_NAME = "vf_media";

/** 媒体票据载荷。 */
export interface MediaTicketPayload {
  scope: string;
  uid: string;
  urole: UserRole;
  iat?: number;
  exp?: number;
}

/**
 * 为 actor 签发短时媒体票据。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param actor 已鉴权主体
 * @returns 已签名的票据字符串
 */
export function signMediaTicket(app: FastifyInstance, actor: Actor): string {
  return app.jwt.sign(
    { scope: MEDIA_TICKET_SCOPE, uid: actor.userId, urole: actor.role },
    { expiresIn: `${MEDIA_TICKET_TTL_MS / 1000}s` },
  );
}

/**
 * 校验媒体票据：签名 / 过期失败、scope 不符或缺失 uid 一律抛 AUTH_INVALID。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param ticket 待校验的票据字符串
 * @returns 票据表达的主体 `{ userId, role }`
 * @throws VideoForgeError(`AUTH_INVALID`) 票据无效 / 过期 / 用途不符
 */
export function verifyMediaTicket(app: FastifyInstance, ticket: string): Actor {
  let payload: MediaTicketPayload;
  try {
    payload = app.jwt.verify<MediaTicketPayload>(ticket);
  } catch {
    // 不泄露票据原文或失败原因
    throw new VideoForgeError("AUTH_INVALID", "媒体票据无效或已过期");
  }

  if (
    payload.scope !== MEDIA_TICKET_SCOPE ||
    typeof payload.uid !== "string" ||
    payload.uid.length === 0
  ) {
    throw new VideoForgeError("AUTH_INVALID", "媒体票据无效或已过期");
  }

  return { userId: payload.uid, role: payload.urole };
}
