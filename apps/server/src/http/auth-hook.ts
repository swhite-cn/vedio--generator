import type { FastifyInstance, FastifyRequest } from "fastify";
import { VideoForgeError, USER_ROLES, type Actor } from "@videoforge/shared";
import { verifyAccessToken } from "../auth/jwt.js";

/**
 * HTTP 层鉴权钩子（见设计文档 §8.1）。
 *
 * 内部信任边界（§8.1）：单进程内不再有跨进程信任问题；`src/agent` / `src/workflow`
 * 只接受 `src/http` 层完成鉴权后的 `actor`（`{ userId, role }`）对象，模块间不传递令牌、
 * 不做二次鉴权。本文件是令牌 → actor 的唯一转换点，绝不把令牌原文写入日志或错误消息。
 */

/**
 * 给 Fastify 请求对象挂载已鉴权的 actor（由 `createAuthPreHandler` 写入）。
 * 使用声明合并扩展请求类型，避免用 `any` 兜底接口契约。
 */
declare module "fastify" {
  interface FastifyRequest {
    /** 当前已鉴权用户；仅在经过鉴权 preHandler 后存在。 */
    actor?: Actor;
  }
}

/**
 * 从 Authorization 头解析并校验令牌，返回 actor。
 * 头缺失、方案不是 `Bearer`（大小写不敏感）或令牌为空时抛 `AUTH_INVALID`；
 * 令牌校验失败由 `verifyAccessToken` 内部抛 `AUTH_INVALID`（不泄露失败原因）。
 * @param app 已注册 JWT 插件的 Fastify 实例（用于 `verifyAccessToken`）
 * @param authorizationHeader 原始 `Authorization` 请求头，缺省为 undefined
 * @returns 已鉴权 actor `{ userId, role }`
 * @throws VideoForgeError 头缺失/格式非法/令牌无效时抛 `AUTH_INVALID`
 */
export function extractActor(app: FastifyInstance, authorizationHeader: string | undefined): Actor {
  const raw = authorizationHeader?.trim();
  if (!raw) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }

  const separatorIndex = raw.indexOf(" ");
  if (separatorIndex < 0) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }
  const scheme = raw.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }

  const token = raw.slice(separatorIndex + 1).trim();
  if (!token) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }

  // 注意：绝不把 token 写入日志或错误消息。
  const payload = verifyAccessToken(app, token);

  // 加固：拒绝不合规载荷，避免把别的用途令牌（如 SSE 短时票据，见 event-ticket.ts）当作 access token 使用。
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }
  // 票据刻意使用 scope 声明用途；带 scope 的令牌不得通过 access token 校验（双向隔离）。
  if ((payload as { scope?: unknown }).scope !== undefined) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }
  if (!USER_ROLES.includes(payload.role)) {
    throw new VideoForgeError("AUTH_INVALID", "缺少或格式非法的 Authorization 头");
  }

  return { userId: payload.sub, role: payload.role };
}

/**
 * 创建鉴权 preHandler：解析请求头并写入 `request.actor`。
 * 鉴权失败会在钩子内抛出 `VideoForgeError("AUTH_INVALID")`，交由统一错误处理器应答 401。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @returns Fastify preHandler 函数（异步）
 */
export function createAuthPreHandler(
  app: FastifyInstance,
): (request: FastifyRequest) => Promise<void> {
  return async (request: FastifyRequest): Promise<void> => {
    request.actor = extractActor(app, request.headers.authorization);
  };
}

/**
 * 取当前请求的 actor；缺失时抛 `AUTH_INVALID`（防御式，正常路径由 preHandler 保证）。
 * @param request Fastify 请求对象
 * @returns 已鉴权 actor
 * @throws VideoForgeError 请求未经鉴权（`request.actor` 缺失）时抛 `AUTH_INVALID`
 */
export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) {
    throw new VideoForgeError("AUTH_INVALID", "请求未经鉴权");
  }
  return request.actor;
}

/**
 * 断言 actor 具有管理员角色。
 * @param actor 已鉴权 actor
 * @throws VideoForgeError 非管理员时抛 `AUTH_FORBIDDEN`
 */
export function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "需要管理员权限");
  }
}
