import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PIPELINE_STAGES,
  componentSelectionSchema,
  sourceRefSchema,
  transitionSchema,
  VideoForgeError,
  type Actor,
  type PipelineStage,
} from "@videoforge/shared";
import {
  readCopyDocument,
  readSceneSpec,
  readThemeSnapshot,
  writeCopyDocV2,
  writeSceneSpec,
} from "@videoforge/pipeline";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { appendMessage } from "../../db/repositories/message-repository.js";
import { getSession, listSessions } from "../../db/repositories/session-repository.js";
import {
  createAgentAction,
  updateAgentActionRun,
} from "../../db/repositories/agent-action-repository.js";
import { createRun } from "../../db/repositories/run-repository.js";
import { assertProjectLease } from "../../workflow/lease.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import { applyShotPatch, applyShotPatchToSpec, type ShotPatchChanges } from "../../domain/shot-patch.js";

/**
 * 分镜镜头可逆编辑路由（见方案 §7.1、§7.3）。
 * PATCH 只改 copy v2 的允许字段，并把 before/after 写入 `agent_actions.plan_json`，供回滚与 diff 展示；
 * 已有 SceneSpec 时同步更新该镜头（组件变化会重新装配动效），其余镜头保持不变。
 */

/** PATCH 请求体 schema：changes 至少一个字段，未知字段拒绝。 */
const patchBodySchema = z.strictObject({
  changes: z
    .strictObject({
      // 屏上文字，最多 200 字（艺术上限由质检拦截）
      onScreenText: z.string().max(200).optional(),
      // 强调词，最多 10 个
      emphasis: z.array(z.string().trim().min(1)).max(10).optional(),
      // 入场转场（三型固定枚举）
      transitionIn: transitionSchema.optional(),
      // 出场转场
      transitionOut: transitionSchema.optional(),
      // 组件 ID + 参数；装配期强校验
      component: componentSelectionSchema.optional(),
      // 来源信息；null 表示清空
      sourceRef: sourceRefSchema.nullable().optional(),
    })
    .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
      message: "changes 至少包含一个字段",
    }),
  // 可选：动作归属会话；缺省取项目最新会话
  sessionId: z.string().trim().min(1).optional(),
  // 可选：动作归属消息；缺省自动追加一条 system 消息作为审计锚点
  messageId: z.string().trim().min(1).optional(),
});

/** 可单镜重生成的阶段（copy 不参与；captions 待 T004 切换后加入）。 */
const REGENERATE_STAGES = ["image", "scene", "tts", "storyboard", "render", "compose"] as const;

/** 单镜重生成请求体：至少一个阶段，可附带自然语言要求。 */
const regenerateBodySchema = z.strictObject({
  stages: z.array(z.enum(REGENERATE_STAGES)).min(1).max(REGENERATE_STAGES.length),
  instruction: z.string().trim().max(500).optional(),
});

/**
 * 解析动作归属会话：显式 sessionId 必须属于该项目；否则取项目最新会话。
 * @param deps HTTP 依赖
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @param sessionId 请求显式传入的会话 ID
 * @returns 会话 ID
 * @throws VideoForgeError(`AUTH_FORBIDDEN`/`CONFIG_INVALID`) 会话不属于项目或项目无会话时
 */
function resolveSessionId(
  deps: HttpDeps,
  actor: Actor,
  projectId: string,
  sessionId?: string,
): string {
  if (sessionId) {
    const session = getSession(deps.db, actor, sessionId);
    if (!session || session.project_id !== projectId) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "会话不存在或不属于该项目");
    }
    return session.id;
  }
  const sessions = [...listSessions(deps.db, actor, projectId)].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const latest = sessions.at(-1);
  if (!latest) {
    throw new VideoForgeError("CONFIG_INVALID", "项目没有会话，无法记录可逆编辑");
  }
  return latest.id;
}

/**
 * 读取主题快照里的动效时长（300–800ms），缺快照时回退 400ms。
 * @param projectDir 项目目录
 * @returns 动效时长毫秒
 */
function resolveAnimationDurationMs(projectDir: string): number {
  try {
    const theme = readThemeSnapshot(projectDir)?.theme;
    if (!theme) return 400;
    return Math.min(Math.max(400, theme.motion.min_duration_ms), theme.motion.max_duration_ms);
  } catch {
    return 400;
  }
}

/**
 * 注册镜头 PATCH 路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerShotRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.patch(
    "/api/projects/:id/shots/:shotId",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const projectId = (request.params as { id: string }).id;
      const shotId = (request.params as { shotId: string }).shotId;

      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }

      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `镜头补丁格式非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }
      const changes = parsed.data.changes as ShotPatchChanges;

      const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
      const copyPath = join(projectDir, "copy.json");
      if (!existsSync(copyPath)) {
        throw new VideoForgeError("CONFIG_INVALID", "项目尚未生成 copy.json");
      }
      const document = readCopyDocument(copyPath);
      if (document.version !== "2") {
        throw new VideoForgeError("CONFIG_INVALID", "仅契约 v2 项目支持镜头编辑");
      }

      const applied = applyShotPatch(document.doc, shotId, changes);
      writeCopyDocV2(copyPath, applied.copy);

      // 已有 SceneSpec 时同步该镜头；未进入 scene 阶段的项目只改 copy
      const existingSpec = readSceneSpec(projectDir);
      let specUpdated = false;
      if (existingSpec) {
        const nextSpec = applyShotPatchToSpec(existingSpec, applied.before, applied.after, {
          animationDurationMs: resolveAnimationDurationMs(projectDir),
        });
        if (nextSpec !== existingSpec) {
          writeSceneSpec(projectDir, nextSpec);
          specUpdated = true;
        }
      }

      const sessionId = resolveSessionId(deps, actor, projectId, parsed.data.sessionId);
      const message =
        parsed.data.messageId === undefined
          ? appendMessage(deps.db, actor, {
              sessionId,
              role: "system",
              payload: {
                type: "shot.patch",
                shotId,
                changes,
                before: applied.before,
                after: applied.after,
              },
            })
          : { id: parsed.data.messageId };

      const action = createAgentAction(deps.db, actor, {
        projectId,
        sessionId,
        messageId: message.id,
        kind: "reversible_edit",
        status: "done",
        plan: {
          action: "shot.patch",
          shotId,
          changes,
          before: applied.before,
          after: applied.after,
          specUpdated,
          scope: { shotIds: [shotId] },
        },
      });
      deps.eventBus.publish(sessionId, "agent_action", { action, shot: applied.after });
      // 方案 §7.2：镜头参数变更后通知前端局部刷新镜头条与 Inspector
      deps.eventBus.publish(sessionId, "shot.updated", {
        projectId,
        shotId,
        changes,
        before: applied.before,
        after: applied.after,
        specUpdated,
      });

      reply.code(200);
      return { shot: applied.after, action, specUpdated };
    },
  );

  app.post(
    "/api/projects/:id/shots/:shotId/regenerate",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const projectId = (request.params as { id: string }).id;
      const shotId = (request.params as { shotId: string }).shotId;

      const project = getProject(deps.db, actor, projectId);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
      }

      const parsed = regenerateBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `重生成请求非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }

      const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
      const copyPath = join(projectDir, "copy.json");
      if (!existsSync(copyPath)) {
        throw new VideoForgeError("CONFIG_INVALID", "项目尚未生成 copy.json");
      }
      const document = readCopyDocument(copyPath);
      if (document.version !== "2") {
        throw new VideoForgeError("CONFIG_INVALID", "仅契约 v2 项目支持镜头重生成");
      }
      const shotIds = document.doc.scenes.flatMap((scene) =>
        scene.shots.map((shot) => shot.shotId),
      );
      if (!shotIds.includes(shotId)) {
        throw new VideoForgeError("CONFIG_INVALID", `镜头不存在：${shotId}`);
      }

      // 阶段去重后按流水线顺序排序，最早阶段即本次 run 的起点
      const stages = [...new Set(parsed.data.stages)].sort(
        (a, b) => (PIPELINE_STAGES as readonly string[]).indexOf(a) - (PIPELINE_STAGES as readonly string[]).indexOf(b),
      ) as PipelineStage[];
      const fromStage = stages[0];
      const scope = { shotIds: [shotId], fromStage };

      assertProjectLease(deps.db, actor, projectId);
      const sessionId = resolveSessionId(deps, actor, projectId);
      const message = appendMessage(deps.db, actor, {
        sessionId,
        role: "system",
        payload: {
          type: "shot.regenerate",
          shotId,
          stages,
          instruction: parsed.data.instruction ?? null,
          scope,
        },
      });

      const action = createAgentAction(deps.db, actor, {
        projectId,
        sessionId,
        messageId: message.id,
        kind: "regenerate",
        status: "executing",
        plan: {
          action: "shot.regenerate",
          shotId,
          stages,
          instruction: parsed.data.instruction ?? null,
          scope,
        },
      });
      const run = createRun(deps.db, actor, {
        projectId,
        sessionId,
        trigger: "user",
        scope,
        contractVersion: project.contract_version,
      });
      const updatedAction = updateAgentActionRun(deps.db, actor, action.id, run.id);
      deps.eventBus.publish(sessionId, "agent_action", { action: updatedAction, scope });

      // 异步触发，避免 HTTP 长时间挂起
      void deps.workflow.run(actor, run.id).catch((err) => {
        app.log.error({ err, runId: run.id }, "[http] 触发镜头重生成失败");
      });

      reply.code(202);
      return { action: updatedAction, run };
    },
  );
}
