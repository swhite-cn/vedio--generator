import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler } from "../auth-hook.js";

/**
 * 输出 Profile 列表路由（见设计文档 §5.2、§6.1）。
 * 选项来自 `config/profiles/*.yaml`，前端不再硬编码；读取失败时返回空列表，
 * 由前端回退到本地默认项（保证离线/异常时仍能新建项目）。
 */

/** 已知 Profile 的中文展示名；新增 Profile 时同步本表。 */
const PROFILE_LABELS: Readonly<Record<string, string>> = {
  "landscape-1080p": "横屏 1080p",
  "portrait-1080p": "竖屏 1080p",
};

/**
 * 注册 Profile 路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖（使用 `rootDir` 定位 `config/profiles`）
 */
export function registerProfileRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get("/api/profiles", { preHandler: createAuthPreHandler(app) }, async (_request, reply) => {
    const dir = join(deps.rootDir, "config", "profiles");
    let names: string[] = [];
    try {
      names = readdirSync(dir)
        .filter((name) => name.endsWith(".yaml"))
        .map((name) => name.slice(0, -".yaml".length))
        .sort();
    } catch (error) {
      console.warn(
        `[http] 读取 config/profiles 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    reply.code(200);
    return {
      profiles: names.map((name) => ({ value: name, label: PROFILE_LABELS[name] ?? name })),
    };
  });
}
