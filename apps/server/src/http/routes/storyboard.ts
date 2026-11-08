import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  AUDIO_CUES_RELATIVE_PATH,
  CAPTIONS_RELATIVE_PATH,
  QUALITY_REPORT_RELATIVE_PATH,
  SCENE_SPEC_RELATIVE_PATH,
  readAudioCues,
  readCopyDocument,
  readQualityReport,
  readSceneSpec,
  readThemeSnapshot,
  readTimelineV2,
} from "@videoforge/pipeline";
import { componentRegistry } from "@videoforge/template-sdk";
import { CONTRACT_VERSION_V2, VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { listProjectAssets } from "../../db/repositories/asset-repository.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";

/**
 * 分镜聚合读取路由（见设计文档 §8.3、方案 §8.4）。
 * 一次性返回工作台/分镜编辑器所需的只读数据：shots、cues、timeline、theme、SceneSpec、assets、quality。
 * 所有读取都限定在 actor 自己的项目目录内；产物缺失返回 null/空数组，不推导状态机。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerStoryboardRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.get(
    "/api/projects/:id/storyboard",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const projectId = (request.params as { id: string }).id;
      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }

      const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
      const copyPath = join(projectDir, "copy.json");
      const copyDocument = existsSync(copyPath) ? readCopyDocument(copyPath) : null;
      const copyV2 = copyDocument?.version === "2" ? copyDocument.doc : null;

      const shots = copyV2
        ? copyV2.scenes.flatMap((scene) =>
            scene.shots.map((shot) => ({
              ...shot,
              sceneId: scene.sceneId,
              chapterNo: scene.chapterNo ?? null,
              sceneTitle: scene.title,
            })),
          )
        : [];
      const scenes = copyV2
        ? copyV2.scenes.map((scene) => ({
            sceneId: scene.sceneId,
            chapterNo: scene.chapterNo ?? null,
            title: scene.title,
            shotIds: scene.shots.map((shot) => shot.shotId),
          }))
        : [];

      const cuesPath = join(projectDir, AUDIO_CUES_RELATIVE_PATH);
      const timelinePath = join(projectDir, "timeline.json");
      const qualityPath = join(projectDir, QUALITY_REPORT_RELATIVE_PATH);

      reply.code(200);
      return {
        project: {
          id: project.id,
          name: project.name,
          contractVersion: project.contract_version,
          themeId: project.theme_id,
          profile: project.profile,
        },
        contractVersion: copyV2 ? CONTRACT_VERSION_V2 : project.contract_version,
        copy: copyV2,
        scenes,
        shots,
        cues: existsSync(cuesPath) ? readAudioCues(cuesPath).cues : [],
        timeline: existsSync(timelinePath) ? readTimelineV2(timelinePath) : null,
        theme: readThemeSnapshot(projectDir),
        spec: readSceneSpec(projectDir),
        components: componentRegistry.list(),
        assets: listProjectAssets(deps.db, actor, project.id),
        quality: existsSync(qualityPath) ? readQualityReport(qualityPath) : null,
        subtitles: existsSync(join(projectDir, CAPTIONS_RELATIVE_PATH))
          ? { relativePath: CAPTIONS_RELATIVE_PATH }
          : null,
        specPath: SCENE_SPEC_RELATIVE_PATH,
      };
    },
  );
}
