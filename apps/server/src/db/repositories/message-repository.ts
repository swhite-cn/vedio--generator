import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
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
