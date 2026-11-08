import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  VideoForgeError,
  type Actor,
  type CopyDocV2,
  type StyleAnchor,
} from "@videoforge/shared";
import { readCopyDocument, stableSeed, writeCopyDocV2 } from "@videoforge/pipeline";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { getProject } from "../../db/repositories/project-repository.js";
import {
  getProjectAsset,
  updateProjectAssetMetadata,
} from "../../db/repositories/asset-repository.js";
import { appendMessage } from "../../db/repositories/message-repository.js";
import { listSessions } from "../../db/repositories/session-repository.js";
import { createAgentAction } from "../../db/repositories/agent-action-repository.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import {
  anchorBoundShotIds,
  applyStyleAnchorPatch,
  applyStyleAnchorRebuild,
  assertAnchorKeyPathSafe,
  findStyleAnchor,
  type StyleAnchorPatchChanges,
} from "../../domain/style-anchor-edit.js";

/**
 * 风格锚运营路由（T401，方案 §5.7/§8.5 素材库）：
 * - `PATCH /api/projects/:id/style-anchors/:key`：绑定/解绑项目图片资产、编辑 seed；
 * - `POST  /api/projects/:id/style-anchors/:key/rebuild`：显式重建（归档缓存图，下一次 image 阶段重新生成）。
 *
 * 所有改动写回 copy v2（内容层唯一真相），并把 before/after 与绑定镜头写入 `agent_actions`；
 * 绑定资产的 `metadata_json` 记录 `styleAnchorKey/generationSeed/boundShotIds` 缓存。
 */

/** seed 上限；与图像生成可接受区间保持一致。 */
const MAX_SEED = 2147483646;
/** 风格锚缓存图相对目录（与 image-generate v2 一致）。 */
const ANCHOR_IMAGES_DIR = "images/anchors";
/** 旧图归档相对目录（与 image-generate v2 一致）。 */
const IMAGE_HISTORY_DIR = "images/history";

/** PATCH 请求体：至少一个字段，未知字段拒绝。 */
const patchBodySchema = z
  .strictObject({
    // 展示名
    label: z.string().trim().min(1).max(40).optional(),
    // 主题色 #RRGGBB
    color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    // 图像生成 seed；null 表示清除
    seed: z.number().int().min(0).max(MAX_SEED).nullable().optional(),
    // 绑定资产 ID；null 表示解绑
    assetId: z.string().trim().min(1).nullable().optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "至少包含一个字段",
  });

/** 重建请求体：可选新 seed；空对象表示保留当前 seed。 */
const rebuildBodySchema = z.strictObject({
  // null 表示清除 seed，恢复 image 阶段稳定派生值
  seed: z.number().int().min(0).max(MAX_SEED).nullable().optional(),
});

/**
 * 解析动作归属会话：取项目最新会话；项目无会话时报配置错误。
 * @param deps HTTP 依赖
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns 会话 ID
 */
function resolveSessionId(deps: HttpDeps, actor: Actor, projectId: string): string {
  const sessions = [...listSessions(deps.db, actor, projectId)].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const latest = sessions.at(-1);
  if (!latest) {
    throw new VideoForgeError("CONFIG_INVALID", "项目没有会话，无法记录风格锚操作");
  }
  return latest.id;
}

/**
 * 读取项目 copy v2 并确保它是契约 v2；同时返回项目目录。
 * @param deps HTTP 依赖
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @param projectName 项目名（决定存储目录）
 * @returns 项目目录与 copy v2 文档
 * @throws VideoForgeError(`CONFIG_INVALID`) copy 缺失或为 v1 时
 */
function readProjectCopyV2(
  deps: HttpDeps,
  actor: Actor,
  projectId: string,
  projectName: string,
): { projectDir: string; copyPath: string; doc: CopyDocV2 } {
  const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, projectName);
  const copyPath = join(projectDir, "copy.json");
  if (!existsSync(copyPath)) {
    throw new VideoForgeError("CONFIG_INVALID", "项目尚未生成 copy.json");
  }
  const document = readCopyDocument(copyPath);
  if (document.version !== "2") {
    throw new VideoForgeError("CONFIG_INVALID", "仅契约 v2 项目支持风格锚运营");
  }
  return { projectDir, copyPath, doc: document.doc as CopyDocV2 };
}

/**
 * 把风格锚缓存图归档到 `images/history/`，避免直接覆盖丢失上一版。
 * @param projectDir 项目绝对目录
 * @param key 已校验可安全用于路径的风格锚 key
 * @returns 是否归档了文件
 */
function archiveAnchorImage(projectDir: string, key: string): boolean {
  const source = join(projectDir, ANCHOR_IMAGES_DIR, `${key}.png`);
  if (!existsSync(source)) return false;
  mkdirSync(join(projectDir, IMAGE_HISTORY_DIR), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(source, join(projectDir, IMAGE_HISTORY_DIR, `anchor-${key}-${stamp}.png`));
  return true;
}

/**
 * 写入风格锚绑定元数据（项目资产 `metadata_json`）。
 * @param deps HTTP 依赖
 * @param actor 请求主体
 * @param anchor 绑定后的锚点
 * @param boundShotIds 引用该锚点的镜头
 */
function writeAnchorMetadata(
  deps: HttpDeps,
  actor: Actor,
  anchor: StyleAnchor,
  boundShotIds: string[],
): void {
  if (!anchor.assetId) return;
  updateProjectAssetMetadata(deps.db, actor, anchor.assetId, {
    styleAnchorKey: anchor.key,
    anchorColor: anchor.color,
    generationSeed: anchor.seed ?? stableSeed(`anchor:${anchor.key}`),
    boundShotIds,
  });
}

/**
 * 清空旧绑定资产的风格锚元数据（换绑或解绑后调用）。
 * @param deps HTTP 依赖
 * @param actor 请求主体
 * @param assetId 旧资产 ID
 */
function clearAnchorMetadata(deps: HttpDeps, actor: Actor, assetId: string | undefined): void {
  if (!assetId) return;
  updateProjectAssetMetadata(deps.db, actor, assetId, {
    styleAnchorKey: null,
    generationSeed: null,
    boundShotIds: [],
  });
}

/**
 * 注册风格锚运营路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerStyleAnchorRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.patch(
    "/api/projects/:id/style-anchors/:key",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id: projectId, key } = request.params as { id: string; key: string };

      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }

      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `风格锚补丁格式非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }

      const { projectDir, copyPath, doc } = readProjectCopyV2(
        deps,
        actor,
        projectId,
        project.name,
      );
      const before = findStyleAnchor(doc, key);
      if (!before) {
        throw new VideoForgeError("CONFIG_INVALID", `风格锚不存在：${key}`);
      }

      const changes: StyleAnchorPatchChanges = { ...parsed.data };
      if (typeof parsed.data.assetId === "string") {
        const asset = getProjectAsset(deps.db, actor, parsed.data.assetId);
        if (!asset || asset.project_id !== projectId) {
          throw new VideoForgeError("ASSET_NOT_FOUND", "绑定资产不存在或不属于该项目");
        }
        if (asset.kind !== "image" || !asset.mime_type.startsWith("image/")) {
          throw new VideoForgeError("ASSET_INVALID", "风格锚只能绑定图片资产");
        }
        // 绑定资产的相对路径直接作为锚点路径，image 阶段按该文件复用
        changes.assetPath = asset.relative_path;
      }

      const applied = applyStyleAnchorPatch(doc, key, changes);
      writeCopyDocV2(copyPath, applied.copy);

      const boundShotIds = anchorBoundShotIds(applied.copy, key);
      if (applied.after.assetId !== before.assetId) {
        clearAnchorMetadata(deps, actor, before.assetId);
      }
      writeAnchorMetadata(deps, actor, applied.after, boundShotIds);

      const sessionId = resolveSessionId(deps, actor, projectId);
      const message = appendMessage(deps.db, actor, {
        sessionId,
        role: "system",
        payload: {
          type: "style-anchor.patch",
          key,
          changes,
          before,
          after: applied.after,
          boundShotIds,
        },
      });
      const action = createAgentAction(deps.db, actor, {
        projectId,
        sessionId,
        messageId: message.id,
        kind: "reversible_edit",
        status: "done",
        plan: {
          action: "style-anchor.patch",
          key,
          changes,
          before,
          after: applied.after,
          boundShotIds,
        },
      });
      deps.eventBus.publish(sessionId, "agent_action", { action, anchor: applied.after });
      // 方案 §7.2：资产绑定变化通知素材库/工作台局部刷新
      deps.eventBus.publish(sessionId, "asset.bound", {
        projectId,
        anchorKey: key,
        assetId: applied.after.assetId ?? null,
        seed: applied.after.seed ?? null,
        boundShotIds,
        action: "style-anchor.patch",
      });

      app.log.info(
        { projectId, key, assetId: applied.after.assetId ?? null, boundShotIds },
        "[style-anchors] 风格锚已更新",
      );
      reply.code(200);
      return { anchor: applied.after, boundShotIds, action };
    },
  );

  app.post(
    "/api/projects/:id/style-anchors/:key/rebuild",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id: projectId, key } = request.params as { id: string; key: string };

      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }

      const parsed = rebuildBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `重建请求非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }

      const { projectDir, copyPath, doc } = readProjectCopyV2(
        deps,
        actor,
        projectId,
        project.name,
      );
      const before = findStyleAnchor(doc, key);
      if (!before) {
        throw new VideoForgeError("CONFIG_INVALID", `风格锚不存在：${key}`);
      }
      assertAnchorKeyPathSafe(key);

      const archived = archiveAnchorImage(projectDir, key);
      const applied = applyStyleAnchorRebuild(doc, key, parsed.data.seed);
      writeCopyDocV2(copyPath, applied.copy);
      clearAnchorMetadata(deps, actor, before.assetId);
      const boundShotIds = anchorBoundShotIds(applied.copy, key);

      const sessionId = resolveSessionId(deps, actor, projectId);
      const message = appendMessage(deps.db, actor, {
        sessionId,
        role: "system",
        payload: {
          type: "style-anchor.rebuild",
          key,
          seed: applied.after.seed ?? null,
          archived,
          before,
          after: applied.after,
          boundShotIds,
        },
      });
      const action = createAgentAction(deps.db, actor, {
        projectId,
        sessionId,
        messageId: message.id,
        kind: "reversible_edit",
        status: "done",
        plan: {
          action: "style-anchor.rebuild",
          key,
          seed: applied.after.seed ?? null,
          archived,
          before,
          after: applied.after,
          boundShotIds,
        },
      });
      deps.eventBus.publish(sessionId, "agent_action", { action, anchor: applied.after });
      deps.eventBus.publish(sessionId, "asset.bound", {
        projectId,
        anchorKey: key,
        assetId: null,
        seed: applied.after.seed ?? null,
        boundShotIds,
        action: "style-anchor.rebuild",
      });

      app.log.info(
        { projectId, key, archived, seed: applied.after.seed ?? null },
        "[style-anchors] 风格锚已标记重建",
      );
      reply.code(200);
      return { anchor: applied.after, boundShotIds, archived, nextStage: "image" };
    },
  );
}
