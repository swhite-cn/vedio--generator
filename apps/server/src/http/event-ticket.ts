import type { FastifyInstance } from "fastify";
import { VideoForgeError, type Actor, type UserRole } from "@videoforge/shared";

/**
 * SSE 短时票据（见设计文档 §4.2 / §4.4 未定 SSE 鉴权、§8.1「token 不得出现在 URL」）。
 *
 * 结论：`EventSource` 不支持自定义请求头，故采用「目的域受限的短时票据」——
 * 票据是独立签发的 JWT，载荷为 `{ scope: "sse", sid, uid, urole }`，有效期 60 秒；
 * 刻意**不与 access token 共用 claim 名**（用 `uid`/`urole` 而非 `sub`/`role`），
 * 配合 auth-hook 的 `scope` 校验形成双向隔离：票据不能当 access token 用，反之亦然。
 * SSE 路由接受 `?ticket=<票据>`（EventSource 路径）或 `Authorization: Bearer <access token>`（fetch / 测试路径）。
 */

/** SSE 票据有效期（毫秒）。代码常量，不进配置。 */
export const EVENT_TICKET_TTL_MS = 60_000;

/** 票据用途声明，防止 access token 与票据混用。 */
export const EVENT_TICKET_SCOPE = "sse";

/** SSE 票据载荷。 */
export interface EventTicketPayload {
  scope: string;
  sid: string;
  uid: string;
  urole: UserRole;
  iat?: number;
  exp?: number;
}

/**
 * 为 actor 与指定会话签发短时 SSE 票据。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param actor 已鉴权主体
 * @param sessionId 目标会话 id（票据与会话绑定）
 * @returns 已签名的票据字符串
 */
export function signEventTicket(app: FastifyInstance, actor: Actor, sessionId: string): string {
  return app.jwt.sign(
    { scope: EVENT_TICKET_SCOPE, sid: sessionId, uid: actor.userId, urole: actor.role },
    { expiresIn: `${EVENT_TICKET_TTL_MS / 1000}s` },
  );
}

/**
 * 校验 SSE 票据：签名/过期失败、scope 不符、sid 与请求会话不符一律抛 AUTH_INVALID。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param ticket 待校验的票据字符串
 * @param sessionId 请求目标的会话 id
 * @returns 票据表达的主体 `{ userId, role }`
 * @throws VideoForgeError(`AUTH_INVALID`) 票据无效 / 过期 / 用途不符 / 会话不匹配
 */
export function verifyEventTicket(app: FastifyInstance, ticket: string, sessionId: string): Actor {
  let payload: EventTicketPayload;
  try {
    payload = app.jwt.verify<EventTicketPayload>(ticket);
  } catch {
    // 不泄露票据原文或失败原因
    throw new VideoForgeError("AUTH_INVALID", "SSE 票据无效或已过期");
  }

  if (
    payload.scope !== EVENT_TICKET_SCOPE ||
    payload.sid !== sessionId ||
    typeof payload.uid !== "string" ||
    payload.uid.length === 0
  ) {
    throw new VideoForgeError("AUTH_INVALID", "SSE 票据无效或已过期");
  }

  return { userId: payload.uid, role: payload.urole };
}
