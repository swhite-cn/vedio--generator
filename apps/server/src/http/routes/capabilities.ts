import type { FastifyInstance } from "fastify";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler } from "../auth-hook.js";
import { listCapabilities } from "../../workflow/capabilities.js";

/**
 * 能力列表路由（见设计文档 §4.2）。
 * 返回能力注册表的只读视图（`CapabilityView` 已剥离 `paramsSchema` 等非序列化字段）。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerCapabilityRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get(
    "/api/capabilities",
    { preHandler: createAuthPreHandler(app) },
    async (_request, reply) => {
      reply.code(200);
      return { capabilities: listCapabilities() };
    },
  );
}
