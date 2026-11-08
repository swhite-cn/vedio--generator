import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import type { Actor } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { loginEvents } from "../schema.js";

/**
 * 登录事件仓储（T311）：追加式记录成功/失败登录，供管理页「登录日志」只读展示。
 * 绝不写入密码或密码哈希；用户名保留原始输入以便排查大小写/拼写问题。
 */

/** 登录日志对外视图（snake_case，与前端展示一致）。 */
export interface LoginEventView {
  id: string;
  user_id: string | null;
  username: string;
  ok: boolean;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/**
 * 断言调用方为 admin（同管理仓储口径）。
 * @param actor 请求主体
 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/**
 * 将数据库行映射为登录日志视图。
 * @param row login_events 行
 * @returns snake_case 视图
 */
function toLoginEventView(row: any): LoginEventView {
  return {
    id: row.id,
    user_id: row.userId ?? null,
    username: row.username,
    ok: Boolean(row.ok),
    reason: row.reason ?? null,
    ip: row.ip ?? null,
    user_agent: row.userAgent ?? null,
    created_at: row.createdAt,
  };
}

export interface CreateLoginEventInput {
  /** 命中的用户 ID；用户不存在或密码错误时为空。 */
  userId?: string | null;
  /** 登录时输入的用户名（原始输入）。 */
  username: string;
  /** 是否成功。 */
  ok: boolean;
  /** 失败原因稳定短码（INVALID_CREDENTIALS / THROTTLED）。 */
  reason?: string | null;
  /** 来源 IP。 */
  ip?: string | null;
  /** User-Agent 原文。 */
  userAgent?: string | null;
}

/**
 * 追加一条登录事件（成功或失败）。
 * @param db Drizzle 数据库实例
 * @param input 登录事件载荷
 * @returns 写入后的对外视图
 */
export function createLoginEvent(db: any, input: CreateLoginEventInput): LoginEventView {
  const row = {
    id: randomUUID(),
    userId: input.userId ?? null,
    username: input.username,
    ok: input.ok,
    reason: input.reason ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: new Date().toISOString(),
  };
  db.insert(loginEvents).values(row).run();
  return toLoginEventView(row);
}

/**
 * 跨用户只读：列出最近登录日志（仅 admin）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param limit 最大条数（默认 100，上限 500）
 * @returns 登录日志（按时间倒序）
 */
export function adminListLoginEvents(db: any, actor: Actor, limit = 100): LoginEventView[] {
  assertAdmin(actor);
  const safeLimit = Math.min(Math.max(1, limit), 500);
  return db
    .select()
    .from(loginEvents)
    .orderBy(desc(loginEvents.createdAt))
    .limit(safeLimit)
    .all()
    .map(toLoginEventView);
}
