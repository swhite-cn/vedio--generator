import type { FastifyInstance } from "fastify";
import type { HttpDeps } from "./deps.js";
import { registerErrorHandler } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCapabilityRoutes } from "./routes/capabilities.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerAdminRoutes } from "./routes/admin.js";

/**
 * 注册全部 HTTP 路由与统一错误处理。
 * P9-B 覆盖 auth / capabilities / projects / sessions（含 SSE）；P9-C 已追加
 * runs / trace、artifacts、media、admin 四组路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖（由 app.ts 组装，测试可注入假实现）
 */
export function registerHttpRoutes(app: FastifyInstance, deps: HttpDeps): void {
  registerErrorHandler(app);
  registerAuthRoutes(app, deps);
  registerCapabilityRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerMediaRoutes(app, deps);
  registerAdminRoutes(app, deps);
}
