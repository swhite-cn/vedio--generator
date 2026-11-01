import type { FastifyInstance } from "fastify";
import { VideoForgeError, type User, type UserRole } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { signAccessToken } from "../../auth/jwt.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import {
  clearLoginFailures,
  getThrottleStatus,
  registerLoginFailure,
} from "../../auth/throttle.js";
import {
  createUser,
  findUserById,
  findUserByUsername,
  normalizeUsername,
  updateLastLogin,
  updatePassword,
} from "../../db/repositories/user-repository.js";

/**
 * 鉴权与用户路由（见设计文档 §4.2、§8.1）。
 * 统一错误响应体由 `registerErrorHandler` 生成；本模块绝不回传密码哈希或明文口令。
 */

/** 对外用户视图（剥离 `password_hash`）。 */
export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

/**
 * 把用户实体转成对外视图：剥离 `password_hash`，绝不返回哈希。
 * @param user 领域用户实体
 * @returns 仅含安全字段的对外视图
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    must_change_password: user.must_change_password,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
  };
}

/**
 * 校验候选密码是否匹配存储串；`verifyPassword` 对长度越界等会抛异常，此处统一按「不匹配」处理。
 * @param plain 候选明文密码
 * @param stored 数据库存储串
 * @returns 匹配返回 true，否则 false（异常亦为 false）
 */
function passwordMatches(plain: string, stored: string): boolean {
  try {
    return verifyPassword(plain, stored);
  } catch {
    return false;
  }
}

/**
 * 注册鉴权与用户路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /**
   * 注册：受 `server.allow_registration` 控制；保留名 admin 与已占用用户名返回完全相同的错误（不暴露保留名）。
   */
  app.post("/api/auth/register", async (request, reply) => {
    const body = (request.body ?? {}) as {
      username?: unknown;
      password?: unknown;
      displayName?: unknown;
    };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (deps.config.server.allow_registration === false) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "自助注册已关闭");
    }

    // 保留名与已占用返回同一错误（§8.1：不通过错误码差异暴露「保留名」）
    const normalized = normalizeUsername(username);
    if (normalized === "admin" || findUserByUsername(deps.db, username)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "用户名不可用");
    }

    const displayName =
      typeof body.displayName === "string" && body.displayName.trim().length > 0
        ? body.displayName
        : normalized;
    const passwordHash = hashPassword(password);
    const user = createUser(deps.db, { username, passwordHash, displayName, role: "user" });
    app.log.info({ userId: user.id }, "[http] 用户注册成功");
    reply.code(201);
    return { user: toPublicUser(user) };
  });

  /** 登录：先查节流，再校验口令；密码错误与节流返回同一错误码与文案。 */
  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (getThrottleStatus(username).throttled) {
      throw new VideoForgeError("AUTH_INVALID", "用户名或密码错误");
    }

    const user = findUserByUsername(deps.db, username);
    const matched = user ? passwordMatches(password, user.password_hash) : false;
    if (!user || !matched) {
      registerLoginFailure(username);
      throw new VideoForgeError("AUTH_INVALID", "用户名或密码错误");
    }

    clearLoginFailures(username);
    updateLastLogin(deps.db, user.id);
    const token = signAccessToken(app, user);
    app.log.info({ userId: user.id }, "[http] 用户登录成功");
    reply.code(200);
    return { token, user: toPublicUser(user) };
  });

  // 依据 §8.1：登出仅清前端 token，服务端不做黑名单（无状态 JWT 的已知取舍），故为无鉴权 no-op。
  app.post("/api/auth/logout", async (_request, reply) => {
    reply.code(200);
    return { ok: true };
  });

  /** 当前用户：重新读库以拿到最新 `must_change_password`。 */
  app.get("/api/auth/me", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const user = findUserById(deps.db, actor.userId);
    if (!user) {
      throw new VideoForgeError("AUTH_INVALID", "用户不存在");
    }
    reply.code(200);
    return { user: toPublicUser(user) };
  });

  /** 修改密码：先校验当前密码，成功后清除强制改密标志。 */
  app.post("/api/auth/password", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    const user = findUserById(deps.db, actor.userId);
    if (!user || !passwordMatches(currentPassword, user.password_hash)) {
      throw new VideoForgeError("AUTH_INVALID", "当前密码不正确");
    }

    const passwordHash = hashPassword(newPassword);
    updatePassword(deps.db, actor, passwordHash, false);
    app.log.info({ userId: actor.userId }, "[http] 用户修改密码成功");
    reply.code(200);
    return { ok: true };
  });
}
