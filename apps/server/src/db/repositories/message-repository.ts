import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Actor, Message, MessageRole } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { messages } from "../schema.js";
import { getSession } from "./session-repository.js";

/** 将数据库行映射为领域 `Message`（`payload` 反序列化，见设计文档 §11）。 */
function toMessage(row: any): Message {
  return {
    id: row.id,
    session_id: row.sessionId,
    run_id: row.runId ?? undefined,
    role: row.role as MessageRole,
    payload: JSON.parse(row.payload) as unknown,
    created_at: row.createdAt,
  };
}

export interface AppendMessageInput {
  id?: string;
  sessionId: string;
  role: MessageRole;
  payload: unknown;
  runId?: string | null;
}

/**
 * 追加一条消息（归属校验：会话必须属于 actor）。
 * 追加式写入，不覆盖历史记录（见设计文档 §11）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input 消息内容
 * @returns 创建后的消息
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 会话不存在或不属于 actor
 */
export function appendMessage(db: any, actor: Actor, input: AppendMessageInput): Message {
  if (!getSession(db, actor, input.sessionId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${input.sessionId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    role: input.role,
    payload: JSON.stringify(input.payload ?? null),
    createdAt: new Date().toISOString(),
  };
  db.insert(messages).values(row).run();
  return toMessage(row);
}

/**
 * 按会话列出消息（按创建时间升序；会话不属于 actor 时返回空）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param sessionId 会话 ID
 * @returns 消息列表
 */
export function listMessages(db: any, actor: Actor, sessionId: string): Message[] {
  if (!getSession(db, actor, sessionId)) return [];
  return db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toMessage);
}

/** 消息游标分页参数。 */
export interface MessagePageOptions {
  /** 每页条数（缺省 50，上限 200）。 */
  limit?: number;
  /** 游标：只取该时间之前的消息（`created_at` ISO 字符串）。 */
  before?: string;
}

/** 消息游标分页结果。 */
export interface MessagePage {
  /** 按 `created_at` 升序的消息列表。 */
  messages: Message[];
  /** 是否还有更早的消息。 */
  hasMore: boolean;
  /** 下一页游标（`hasMore` 为 true 时等于最旧一条的 `created_at`）。 */
  nextBefore: string | null;
}

/**
 * 按会话游标分页列出消息（用于聊天历史回放）。
 * 查询按时间倒序取 `limit` 条后反转为升序，`nextBefore` 指向本页最旧一条。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param sessionId 会话 ID
 * @param options 分页参数
 * @returns 分页结果；会话不属于 actor 时返回空页
 */
export function listMessagesPage(
  db: any,
  actor: Actor,
  sessionId: string,
  options: MessagePageOptions = {},
): MessagePage {
  if (!getSession(db, actor, sessionId)) {
    return { messages: [], hasMore: false, nextBefore: null };
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions = [eq(messages.sessionId, sessionId)];
  if (options.before) conditions.push(lt(messages.createdAt, options.before));

  const rows = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1)
    .all()
    .map(toMessage) as Message[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ascending = page.reverse();
  return {
    messages: ascending,
    hasMore,
    nextBefore: hasMore && ascending.length > 0 ? ascending[0].created_at : null,
  };
}
