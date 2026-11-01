import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Actor, User, UserRole } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { users } from "../schema.js";

/**
 * 将用户名归一化为小写（大小写不敏感唯一的实现方式：写入与比较前统一 `toLowerCase()`）。
 * 见设计文档 §8.1「用户名不区分大小写」。
 * @param username 原始用户名
 * @returns 归一化后的用户名
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * 断言调用方为 admin，否则抛 `AUTH_FORBIDDEN`。
 * 跨用户读写在 §8.3 只允许由显式 `admin*` 方法放开，本函数是这些方法的守卫。
 * @param actor 请求主体
 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/** 将数据库行映射为领域 `User`（snake_case，见设计文档 §11）。 */
function toUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    password_hash: row.passwordHash,
    display_name: row.displayName,
    role: row.role as UserRole,
    must_change_password: row.mustChangePassword,
    created_at: row.createdAt,
    last_login_at: row.lastLoginAt ?? null,
  };
}

export interface CreateUserInput {
  id?: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role?: UserRole;
  mustChangePassword?: boolean;
}

/**
 * 创建用户（用户名归一化后写入，保证大小写不敏感唯一）。
 * 供鉴权层（P5）与 CLI `db:user --create` 使用；注册关闭校验等业务规则不在此层。
 * @param db Drizzle 数据库实例
 * @param input 用户信息
 * @returns 创建后的用户
 */
export function createUser(db: any, input: CreateUserInput): User {
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? randomUUID(),
    username: normalizeUsername(input.username),
    passwordHash: input.passwordHash,
    displayName: input.displayName,
    role: input.role ?? "user",
    mustChangePassword: input.mustChangePassword ?? false,
    createdAt: now,
    lastLoginAt: null,
  };
  db.insert(users).values(row).run();
  console.info(`[user-repository] created user: ${row.id}`);
  return toUser(row);
}

/**
 * 按 ID 读取用户（鉴权层在无 actor 的登录/令牌校验路径使用）。
 * @param db Drizzle 数据库实例
 * @param id 用户 ID
 * @returns 用户或 undefined
 */
export function findUserById(db: any, id: string): User | undefined {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toUser(row) : undefined;
}

/**
 * 按用户名读取用户（大小写不敏感；登录路径在鉴权前使用，无 actor）。
 * @param db Drizzle 数据库实例
 * @param username 用户名
 * @returns 用户或 undefined
 */
export function findUserByUsername(db: any, username: string): User | undefined {
  const row = db
    .select()
    .from(users)
    .where(eq(users.username, normalizeUsername(username)))
    .get();
  return row ? toUser(row) : undefined;
}

/**
 * 更新某用户最近登录时间。
 * @param db Drizzle 数据库实例
 * @param userId 用户 ID
 * @param at 登录时间（默认当前时间）
 */
export function updateLastLogin(db: any, userId: string, at = new Date().toISOString()): void {
  db.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId)).run();
}

/**
 * 修改当前用户（actor）自己的密码。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体（目标即 actor 自身）
 * @param passwordHash 新的密码哈希
 * @param mustChangePassword 是否仍需强制改密（改密成功传 false）
 */
export function updatePassword(
  db: any,
  actor: Actor,
  passwordHash: string,
  mustChangePassword = false,
): void {
  db.update(users)
    .set({ passwordHash, mustChangePassword })
    .where(eq(users.id, actor.userId))
    .run();
  console.info(`[user-repository] password updated for user: ${actor.userId}`);
}

/**
 * 跨用户只读：列出全部用户（供 `GET /api/admin/users`，仅 admin）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @returns 用户列表（不含明文密码，仅含密码哈希）
 */
export function adminListUsers(db: any, actor: Actor): User[] {
  assertAdmin(actor);
  return db.select().from(users).all().map(toUser);
}

/**
 * 跨用户写：重置指定用户密码并置 `must_change_password`（供 `/api/admin/users/:id/reset-password`，仅 admin）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param targetUserId 目标用户 ID
 * @param passwordHash 新的密码哈希
 */
export function adminResetPassword(
  db: any,
  actor: Actor,
  targetUserId: string,
  passwordHash: string,
): void {
  assertAdmin(actor);
  const result = db
    .update(users)
    .set({ passwordHash, mustChangePassword: true })
    .where(eq(users.id, targetUserId))
    .run();
  if (result.changes === 0) {
    throw new VideoForgeError("CONFIG_INVALID", `User not found: ${targetUserId}`);
  }
  console.info(`[user-repository] admin reset password for user: ${targetUserId}`);
}
