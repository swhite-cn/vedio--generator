import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sum } from "drizzle-orm";
import type {
  Actor,
  MessageAssetRef,
  ProjectAsset,
  ProjectAssetKind,
  ProjectAssetSource,
  ProjectVisualCategory,
} from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { messageAssetRefs, messages, projectAssets, projects, sessions } from "../schema.js";
import { getProject } from "./project-repository.js";

/** 将数据库行映射为共享项目资产。 */
function toProjectAsset(row: any): ProjectAsset {
  return {
    id: row.id,
    project_id: row.projectId,
    source: row.source as ProjectAssetSource,
    kind: row.kind as ProjectAssetKind,
    visual_category: (row.visualCategory ?? null) as ProjectVisualCategory | null,
    label: row.label,
    relative_path: row.relativePath,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    run_id: row.runId ?? null,
    stage: row.stage ?? null,
    supersedes_asset_id: row.supersedesAssetId ?? null,
    metadata_json: JSON.parse(row.metadataJson ?? "{}") as unknown,
    created_at: row.createdAt,
  };
}

/** 将数据库行映射为消息资产引用。 */
function toMessageAssetRef(row: any): MessageAssetRef {
  return {
    id: row.id,
    message_id: row.messageId,
    asset_id: row.assetId,
    ordinal: row.ordinal,
    created_at: row.createdAt,
  };
}

export interface CreateProjectAssetInput {
  id?: string;
  projectId: string;
  source: ProjectAssetSource;
  kind: ProjectAssetKind;
  /** 素材库展示分类；缺省为空，由同步/上传流程按来源推断。 */
  visualCategory?: ProjectVisualCategory | null;
  label: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  runId?: string | null;
  stage?: string | null;
  supersedesAssetId?: string | null;
  metadata?: unknown;
}

export interface ProjectAssetQuery {
  kind?: ProjectAssetKind;
  source?: ProjectAssetSource;
  /** 素材库分类筛选（T118 接入 UI）。 */
  visualCategory?: ProjectVisualCategory;
}

/**
 * 创建项目资产记录。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param input 资产元数据
 * @returns 新建资产
 */
export function createProjectAsset(
  db: any,
  actor: Actor,
  input: CreateProjectAssetInput,
): ProjectAsset {
  if (!getProject(db, actor, input.projectId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${input.projectId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    projectId: input.projectId,
    source: input.source,
    kind: input.kind,
    visualCategory: input.visualCategory ?? null,
    label: input.label,
    relativePath: input.relativePath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    runId: input.runId ?? null,
    stage: input.stage ?? null,
    supersedesAssetId: input.supersedesAssetId ?? null,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: new Date().toISOString(),
  };
  db.insert(projectAssets).values(row).run();
  return toProjectAsset(row);
}

/**
 * 列出当前 actor 指定项目的资产。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param projectId 项目 ID
 * @param query 可选类型和来源筛选
 * @returns 资产列表；项目不属于当前 actor 时返回空数组
 */
export function listProjectAssets(
  db: any,
  actor: Actor,
  projectId: string,
  query: ProjectAssetQuery = {},
): ProjectAsset[] {
  if (!getProject(db, actor, projectId)) return [];
  const conditions = [eq(projectAssets.projectId, projectId)];
  if (query.kind) conditions.push(eq(projectAssets.kind, query.kind));
  if (query.source) conditions.push(eq(projectAssets.source, query.source));
  if (query.visualCategory) {
    conditions.push(eq(projectAssets.visualCategory, query.visualCategory));
  }
  return db
    .select()
    .from(projectAssets)
    .where(and(...conditions))
    .orderBy(asc(projectAssets.createdAt))
    .all()
    .map(toProjectAsset);
}

/**
 * 按 ID 查询当前 actor 可见的资产。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param assetId 资产 ID
 * @returns 资产；不存在或无权访问时返回 undefined
 */
export function getProjectAsset(db: any, actor: Actor, assetId: string): ProjectAsset | undefined {
  const row = db
    .select({ asset: projectAssets })
    .from(projectAssets)
    .innerJoin(projects, eq(projectAssets.projectId, projects.id))
    .where(and(eq(projectAssets.id, assetId), eq(projects.userId, actor.userId)))
    .get();
  return row ? toProjectAsset(row.asset) : undefined;
}

/**
 * 合并更新项目资产的 `metadata_json`（T401 风格锚绑定留痕）。
 * 保留已有键，仅覆盖 patch 中出现的键；patch 传入 `null` 表示清空该键。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param assetId 资产 ID
 * @param patch 待合并的元数据
 * @returns 更新后的资产；资产不存在或无权访问时返回 undefined
 */
export function updateProjectAssetMetadata(
  db: any,
  actor: Actor,
  assetId: string,
  patch: Record<string, unknown>,
): ProjectAsset | undefined {
  const asset = getProjectAsset(db, actor, assetId);
  if (!asset) return undefined;
  const existing =
    asset.metadata_json && typeof asset.metadata_json === "object" && !Array.isArray(asset.metadata_json)
      ? (asset.metadata_json as Record<string, unknown>)
      : {};
  const metadataJson = JSON.stringify({ ...existing, ...patch });
  db.update(projectAssets)
    .set({ metadataJson })
    .where(eq(projectAssets.id, assetId))
    .run();
  return getProjectAsset(db, actor, assetId);
}

/**
 * 获取项目中的一组指定资产，并保持请求的顺序。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param projectId 项目 ID
 * @param assetIds 去重后的资产 ID
 * @returns 查到的资产
 */
export function getProjectAssetsByIds(
  db: any,
  actor: Actor,
  projectId: string,
  assetIds: string[],
): ProjectAsset[] {
  if (assetIds.length === 0 || !getProject(db, actor, projectId)) return [];
  const rows: ProjectAsset[] = db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.projectId, projectId), inArray(projectAssets.id, assetIds)))
    .all()
    .map((row: any) => toProjectAsset(row));
  const byId = new Map(rows.map((asset) => [asset.id, asset]));
  return assetIds.flatMap((assetId) => {
    const asset = byId.get(assetId);
    return asset ? [asset] : [];
  });
}

/**
 * 创建消息对项目资产的引用关系。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param messageId 用户消息 ID
 * @param assetIds 待引用资产 ID，可含重复项
 * @returns 新增引用
 */
export function createMessageAssetRefs(
  db: any,
  actor: Actor,
  messageId: string,
  assetIds: string[],
): MessageAssetRef[] {
  const message = db
    .select({ message: messages, projectId: sessions.projectId })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(eq(messages.id, messageId), eq(projects.userId, actor.userId)))
    .get();
  if (!message) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Message not found: ${messageId}`);
  }

  const uniqueIds = [...new Set(assetIds)];
  const assets = getProjectAssetsByIds(db, actor, message.projectId, uniqueIds);
  if (assets.length !== uniqueIds.length) {
    throw new VideoForgeError("AUTH_FORBIDDEN", "引用资产不存在或不属于当前项目");
  }

  const now = new Date().toISOString();
  const refs = uniqueIds.map((assetId, ordinal) => ({
    id: randomUUID(),
    messageId,
    assetId,
    ordinal,
    createdAt: now,
  }));
  if (refs.length > 0) db.insert(messageAssetRefs).values(refs).run();
  return refs.map(toMessageAssetRef);
}

/**
 * 按消息批量读取可见的资产引用。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param messageIds 消息 ID 列表
 * @returns 以消息 ID 分组的引用
 */
export function listMessageAssetRefs(
  db: any,
  actor: Actor,
  messageIds: string[],
): Map<string, MessageAssetRef[]> {
  const result = new Map<string, MessageAssetRef[]>();
  if (messageIds.length === 0) return result;
  const rows = db
    .select({ ref: messageAssetRefs })
    .from(messageAssetRefs)
    .innerJoin(messages, eq(messageAssetRefs.messageId, messages.id))
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(inArray(messageAssetRefs.messageId, messageIds), eq(projects.userId, actor.userId)))
    .orderBy(asc(messageAssetRefs.ordinal))
    .all();
  for (const row of rows) {
    const ref = toMessageAssetRef(row.ref);
    const refs = result.get(ref.message_id) ?? [];
    refs.push(ref);
    result.set(ref.message_id, refs);
  }
  return result;
}

/**
 * 汇总当前项目用户上传资产的字节数。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param projectId 项目 ID
 * @returns 已上传资产总字节数
 */
export function sumUploadedAssetBytes(db: any, actor: Actor, projectId: string): number {
  if (!getProject(db, actor, projectId)) return 0;
  const row = db
    .select({ total: sum(projectAssets.sizeBytes) })
    .from(projectAssets)
    .where(and(eq(projectAssets.projectId, projectId), eq(projectAssets.source, "uploaded")))
    .get();
  return Number(row?.total ?? 0);
}
