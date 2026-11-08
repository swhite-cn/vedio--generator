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
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerStoryboardRoutes } from "./routes/storyboard.js";
import { registerShotRoutes } from "./routes/shots.js";
import { registerStyleAnchorRoutes } from "./routes/style-anchors.js";
import { registerAgentActionRoutes } from "./routes/agent-actions.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerQualityRoutes } from "./routes/quality.js";
import { registerPlayerRoutes } from "./routes/player.js";
import { registerSearchRoutes } from "./routes/search.js";

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
  registerStoryboardRoutes(app, deps);
  registerShotRoutes(app, deps);
  registerStyleAnchorRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerAgentActionRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerQualityRoutes(app, deps);
  registerPlayerRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerMediaRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerAdminRoutes(app, deps);
}
