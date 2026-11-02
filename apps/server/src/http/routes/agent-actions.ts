import type { FastifyInstance } from "fastify";
import { VideoForgeError } from "@videoforge/shared";
import {
  cancelAgentAction,
  confirmAgentAction,
  getAgentAction,
} from "../../db/repositories/agent-action-repository.js";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";

/**
 * 注册 Agent 动作确认与取消路由。
 * 当前版本只改变动作状态并发布事件；具体断点续跑由后续工具根据动作计划创建 Run。
 * @param app Fastify 实例
 * @param deps HTTP 运行期依赖
 */
export function registerAgentActionRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 确认高影响动作，防止同一动作被重复确认。 */
  app.post("/api/agent-actions/:id/confirm", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const id = (request.params as { id: string }).id;
    const action = confirmAgentAction(deps.db, actor, id);
    deps.eventBus.publish(action.session_id, "agent_action", { action });
    return { action };
  });

  /** 取消仍处于待确认状态的动作。 */
  app.post("/api/agent-actions/:id/cancel", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const id = (request.params as { id: string }).id;
    const action = cancelAgentAction(deps.db, actor, id);
    deps.eventBus.publish(action.session_id, "agent_action", { action });
    return { action };
  });

  /** 查询动作状态，供前端在 SSE 重连或历史回放时自愈。 */
  app.get("/api/agent-actions/:id", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const action = getAgentAction(deps.db, actor, (request.params as { id: string }).id);
    if (!action) throw new VideoForgeError("ACTION_NOT_CONFIRMABLE", "动作不存在或无访问权限");
    return { action };
  });
}
