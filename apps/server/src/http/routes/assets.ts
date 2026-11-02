import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { latestGenerationRecords } from "@videoforge/pipeline";
import type { ProjectAssetKind, ProjectAssetSource } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import {
  assertUploadSize,
  classifyUpload,
  moveUploadedFile,
  resolveUploadPath,
  toProjectRelativeAssetPath,
  validateUploadName,
  validateUploadSignature,
} from "../../domain/project-assets.js";
import {
  createProjectAsset,
  getProjectAsset,
  listProjectAssets,
  sumUploadedAssetBytes,
} from "../../db/repositories/asset-repository.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { buildArtifactIndex } from "../artifacts.js";
import { getCapability } from "../../workflow/capabilities.js";
import { syncGeneratedProjectAssets } from "../../domain/project-assets.js";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";

/** 解析并验证资产来源查询参数。 */
function parseSource(value: unknown): ProjectAssetSource | undefined {
  if (value === undefined) return undefined;
  if (value === "generated" || value === "uploaded") return value;
  throw new VideoForgeError("ASSET_INVALID", "资产来源筛选条件非法");
}

/** 解析并验证资产类型查询参数。 */
function parseKind(value: unknown): ProjectAssetKind | undefined {
  if (value === undefined) return undefined;
  const kinds: readonly ProjectAssetKind[] = [
    "document",
    "image",
    "audio",
    "copy",
    "scene",
    "timeline",
    "video",
    "frames",
  ];
  if (typeof value === "string" && kinds.includes(value as ProjectAssetKind)) {
    return value as ProjectAssetKind;
  }
  throw new VideoForgeError("ASSET_INVALID", "资产类型筛选条件非法");
}

/**
 * 注册项目资产查询与上传路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerAssetRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 列出当前 actor 指定项目的资产。 */
  app.get("/api/projects/:id/assets", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const projectId = (request.params as { id: string }).id;
    const query = request.query as { kind?: unknown; source?: unknown };
    const project = getProject(deps.db, actor, projectId);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
    }
    const capability = getCapability(project.capability_id);
    if (capability) {
      const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
      syncGeneratedProjectAssets(
        deps.db,
        actor,
        project,
        buildArtifactIndex(projectDir, capability, project.profile),
      );
    }
    return {
      items: listProjectAssets(deps.db, actor, projectId, {
        kind: parseKind(query.kind),
        source: parseSource(query.source),
      }),
    };
  });

  /**
   * 列出项目最近一次生成的上下文（每个产物一条）。
   * 供产物面板展示「当时实际发送的提示词 / 模型 / 是否降级」，精调单场景时可直接引用。
   */
  app.get("/api/projects/:id/generations", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const projectId = (request.params as { id: string }).id;
    const project = getProject(deps.db, actor, projectId);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
    }
    const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
    return { items: latestGenerationRecords(projectDir) };
  });

  /** 上传单个项目素材，并以稳定资产记录返回。 */
  app.post("/api/projects/:id/assets/upload", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const projectId = (request.params as { id: string }).id;
    const project = getProject(deps.db, actor, projectId);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
    }

    const upload = await request.file();
    if (!upload) {
      throw new VideoForgeError("ASSET_INVALID", "请选择一个上传文件");
    }
    const filename = validateUploadName(upload.filename);
    const kind = classifyUpload(filename, upload.mimetype);
    const usedBytes = sumUploadedAssetBytes(deps.db, actor, projectId);
    if (usedBytes >= deps.config.assets.max_project_upload_bytes) {
      upload.file.resume();
      throw new VideoForgeError("ASSET_TOO_LARGE", "项目上传文件总量已达到上限");
    }

    const assetId = randomUUID();
    const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
    const targetPath = resolveUploadPath(projectDir, assetId, filename);
    const temporaryPath = `${targetPath}.uploading`;
    await mkdir(dirname(temporaryPath), { recursive: true });

    try {
      await pipeline(upload.file, createWriteStream(temporaryPath, { flags: "wx" }));
      if (upload.file.truncated) {
        throw new VideoForgeError("ASSET_TOO_LARGE", "上传文件超过单文件大小限制");
      }
      const sizeBytes = await assertUploadSize(temporaryPath, deps.config.assets.max_upload_bytes);
      if (usedBytes + sizeBytes > deps.config.assets.max_project_upload_bytes) {
        throw new VideoForgeError("ASSET_TOO_LARGE", "上传文件超过项目总量限制");
      }
      await validateUploadSignature(temporaryPath, upload.mimetype);
      await moveUploadedFile(temporaryPath, targetPath);

      const asset = createProjectAsset(deps.db, actor, {
        id: assetId,
        projectId,
        source: "uploaded",
        kind,
        label: filename,
        relativePath: toProjectRelativeAssetPath(projectDir, targetPath),
        mimeType: upload.mimetype,
        sizeBytes,
      });
      app.log.info(
        { projectId, assetId: asset.id, kind: asset.kind, sizeBytes: asset.size_bytes },
        "[assets] 上传项目资产成功",
      );
      return { asset };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });

  /** 获取当前 actor 可见的单条资产元数据。 */
  app.get("/api/projects/:id/assets/:assetId", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const { id: projectId, assetId } = request.params as { id: string; assetId: string };
    const asset = getProjectAsset(deps.db, actor, assetId);
    if (!asset || asset.project_id !== projectId) {
      throw new VideoForgeError("ASSET_NOT_FOUND", "项目资产不存在");
    }
    return { asset };
  });
}
