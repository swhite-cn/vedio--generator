import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Actor, AgentAction, AgentActionKind, AgentActionStatus } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { agentActions, messages, projects, sessions } from "../schema.js";

/** 将数据库行转换为共享 Agent 动作。 */
function toAgentAction(row: any): AgentAction {
  return {
    id: row.id,
    project_id: row.projectId,
    session_id: row.sessionId,
    message_id: row.messageId,
    kind: row.kind as AgentActionKind,
    status: row.status as AgentActionStatus,
    plan_json: JSON.parse(row.planJson),
    run_id: row.runId ?? null,
    error_code: row.errorCode ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** 验证动作所属项目、会话和消息全部归当前 actor。 */
function ownsMessage(
  db: any,
  actor: Actor,
  sessionId: string,
  messageId: string,
  projectId: string,
): boolean {
  return Boolean(
    db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.sessionId, sessionId),
          eq(sessions.projectId, projectId),
          eq(projects.userId, actor.userId),
        ),
      )
      .get(),
  );
}

/** 创建一条追加式 Agent 动作记录。 */
export function createAgentAction(
  db: any,
  actor: Actor,
  input: {
    projectId: string;
    sessionId: string;
    messageId: string;
    kind: AgentActionKind;
    status: AgentActionStatus;
    plan: unknown;
  },
): AgentAction {
  if (!ownsMessage(db, actor, input.sessionId, input.messageId, input.projectId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", "消息不属于当前项目");
  }
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    kind: input.kind,
    status: input.status,
    planJson: JSON.stringify(input.plan),
    runId: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(agentActions).values(row).run();
  return toAgentAction(row);
}

/** 获取当前 actor 可见的 Agent 动作。 */
export function getAgentAction(db: any, actor: Actor, actionId: string): AgentAction | undefined {
  const row = db
    .select({ action: agentActions })
    .from(agentActions)
    .innerJoin(projects, eq(agentActions.projectId, projects.id))
    .where(and(eq(agentActions.id, actionId), eq(projects.userId, actor.userId)))
    .get();
  return row ? toAgentAction(row.action) : undefined;
}

/** 按消息读取当前 actor 可见的动作。 */
export function listAgentActionsForMessage(
  db: any,
  actor: Actor,
  messageId: string,
): AgentAction[] {
  return db
    .select({ action: agentActions })
    .from(agentActions)
    .innerJoin(projects, eq(agentActions.projectId, projects.id))
    .where(and(eq(agentActions.messageId, messageId), eq(projects.userId, actor.userId)))
    .orderBy(asc(agentActions.createdAt))
    .all()
    .map((row: any) => toAgentAction(row.action));
}

/**
 * 原子确认待确认动作。仅状态仍为 `waiting_confirmation` 时成功，防止重复执行。
 */
export function confirmAgentAction(db: any, actor: Actor, actionId: string): AgentAction {
  const action = getAgentAction(db, actor, actionId);
  if (!action || action.status !== "waiting_confirmation") {
    throw new VideoForgeError("ACTION_NOT_CONFIRMABLE", "该动作已终结、未等待确认或无访问权限");
  }
  const now = new Date().toISOString();
  const result = db
    .update(agentActions)
    .set({ status: "executing", updatedAt: now })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.status, "waiting_confirmation")))
    .run();
  if (result.changes !== 1) {
    throw new VideoForgeError("ACTION_NOT_CONFIRMABLE", "该动作已被处理");
  }
  return { ...action, status: "executing", updated_at: now };
}

/** 原子取消待确认动作。 */
export function cancelAgentAction(db: any, actor: Actor, actionId: string): AgentAction {
  const action = getAgentAction(db, actor, actionId);
  if (!action || action.status !== "waiting_confirmation") {
    throw new VideoForgeError("ACTION_NOT_CONFIRMABLE", "该动作不可取消");
  }
  const now = new Date().toISOString();
  const result = db
    .update(agentActions)
    .set({ status: "canceled", updatedAt: now })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.status, "waiting_confirmation")))
    .run();
  if (result.changes !== 1) {
    throw new VideoForgeError("ACTION_NOT_CONFIRMABLE", "该动作已被处理");
  }
  return { ...action, status: "canceled", updated_at: now };
}
