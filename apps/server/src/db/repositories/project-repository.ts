import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Actor, Project, ProjectStatus } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { validateProjectName } from "@videoforge/pipeline";
import { projects } from "../schema.js";

/** 断言调用方为 admin，否则抛 `AUTH_FORBIDDEN`。 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/** 将数据库行映射为领域 `Project`（snake_case，见设计文档 §11）。 */
function toProject(row: any): Project {
  return {
    id: row.id,
    user_id: row.userId,
    capability_id: row.capabilityId,
    name: row.name,
    topic: row.topic,
    style: row.style ?? null,
    profile: row.profile,
    status: row.status as ProjectStatus,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * 解析用户范围内的唯一项目名：合法名冲突时依次追加 `-2`、`-3`…（见设计文档 §8.3）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param name 用户输入的项目名
 * @returns 归一化且用户范围内唯一的项目名
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) 名称非法时
 */
export function resolveUniqueProjectName(db: any, actor: Actor, name: string): string {
  const base = validateProjectName(name);
  const existing = new Set(
    db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.userId, actor.userId))
      .all()
      .map((row: any) => row.name as string),
  );
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  const unique = `${base}-${suffix}`;
  console.info(`[project-repository] project name conflict, resolved to: ${unique}`);
  return unique;
}

export interface CreateProjectInput {
  id?: string;
  capabilityId: string;
  name: string;
  topic: string;
  style?: string | null;
  profile: string;
  status?: ProjectStatus;
}

/**
 * 创建项目（归属写入 actor.userId；项目名在用户范围内去重）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input 项目信息
 * @returns 创建后的项目
 */
export function createProject(db: any, actor: Actor, input: CreateProjectInput): Project {
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? randomUUID(),
    userId: actor.userId,
    capabilityId: input.capabilityId,
    name: resolveUniqueProjectName(db, actor, input.name),
    topic: input.topic,
    style: input.style ?? null,
    profile: input.profile,
    status: input.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(projects).values(row).run();
  console.info(`[project-repository] created project: ${row.id}`);
  return toProject(row);
}

/**
 * 按 ID 读取项目（SQL 层限定 `user_id = actor.userId`，禁止内存判归属）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns 项目或 undefined（不存在或不属于 actor）
 */
export function getProject(db: any, actor: Actor, projectId: string): Project | undefined {
  const row = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, actor.userId)))
    .get();
  return row ? toProject(row) : undefined;
}

/**
 * 列出当前用户的项目（仅自己的）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @returns 项目列表
 */
export function listProjects(db: any, actor: Actor): Project[] {
  return db.select().from(projects).where(eq(projects.userId, actor.userId)).all().map(toProject);
}

/**
 * 更新项目状态（仅允许更新 actor 自己的项目）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @param status 目标状态
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 项目不存在或不属于 actor
 */
export function updateProjectStatus(
  db: any,
  actor: Actor,
  projectId: string,
  status: ProjectStatus,
): void {
  const result = db
    .update(projects)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(projects.id, projectId), eq(projects.userId, actor.userId)))
    .run();
  if (result.changes === 0) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${projectId}`);
  }
}

/**
 * 跨用户只读：列出全站项目（供 `GET /api/admin/projects`，仅 admin）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @returns 全站项目列表
 */
export function adminListProjects(db: any, actor: Actor): Project[] {
  assertAdmin(actor);
  return db.select().from(projects).all().map(toProject);
}
