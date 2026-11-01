import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Actor, Session } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { projects, sessions } from "../schema.js";
import { getProject } from "./project-repository.js";

/** 将数据库行映射为领域 `Session`（snake_case，见设计文档 §11）。 */
function toSession(row: any): Session {
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export interface CreateSessionInput {
  id?: string;
  projectId: string;
  title: string;
}

/**
 * 为 actor 自己的项目创建会话。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input 会话信息
 * @returns 创建后的会话
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 项目不存在或不属于 actor
 */
export function createSession(db: any, actor: Actor, input: CreateSessionInput): Session {
  const project = getProject(db, actor, input.projectId);
  if (!project) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${input.projectId}`);
  }
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? randomUUID(),
    projectId: input.projectId,
    title: input.title,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(sessions).values(row).run();
  console.info(`[session-repository] created session: ${row.id}`);
  return toSession(row);
}

/**
 * 按 ID 读取会话（join projects 限定 `user_id = actor.userId`，避免内存判归属）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param sessionId 会话 ID
 * @returns 会话或 undefined（不存在或不属于 actor）
 */
export function getSession(db: any, actor: Actor, sessionId: string): Session | undefined {
  const row = db
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(eq(sessions.id, sessionId), eq(projects.userId, actor.userId)))
    .get();
  return row ? toSession(row.session) : undefined;
}

/**
 * 列出 actor 某个项目下的会话。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns 会话列表（项目不属于 actor 时为空）
 */
export function listSessions(db: any, actor: Actor, projectId: string): Session[] {
  if (!getProject(db, actor, projectId)) return [];
  return db.select().from(sessions).where(eq(sessions.projectId, projectId)).all().map(toSession);
}
