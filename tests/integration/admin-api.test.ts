import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// 测试文件位于仓库根 tests/，根 node_modules 在 pnpm 严格隔离下不暴露 fastify；
// 走 server 工作区本地实例解析（与 apps/server/src 内部 import 'fastify' 指向同一实例）。
import Fastify from "../../apps/server/node_modules/fastify/fastify.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Actor, Run } from "@videoforge/shared";
import { migrateDatabase, createDatabase } from "../../apps/server/src/db";
import { registerJwt, signAccessToken } from "../../apps/server/src/auth/jwt";
import { hashPassword } from "../../apps/server/src/auth/password";
import { createUser, findUserById } from "../../apps/server/src/db/repositories/user-repository";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { createRun } from "../../apps/server/src/db/repositories/run-repository";
import { recordToolCall } from "../../apps/server/src/db/repositories/trace-repository";
import { createEventBus } from "../../apps/server/src/http/event-bus";
import { registerHttpRoutes } from "../../apps/server/src/http/index";
import type { ChatPort, HttpDeps } from "../../apps/server/src/http/deps";
import type { WorkflowEngine } from "../../apps/server/src/workflow/engine";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/**
 * 管理 API（/api/admin/*）的 HTTP 集成测试（P9-C）。
 * 用真实 SQLite 临时库 + 真实 Fastify 应用（注入假 workflow/chat）覆盖：
 * 非 admin 全量 403、admin 正向读取（用户列表剥离密码哈希、重置密码、run 过滤、跨用户 trace）。
 */

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const TEST_SECRET = "a".repeat(32);
const PASSWORD = "password123";
/** 重置密码使用的新口令。 */
const NEW_PASSWORD = "reset-password-1";

let directory: string;
let database: ReturnType<typeof createDatabase>;
const apps: Array<ReturnType<typeof Fastify>> = [];

/** 假工作流引擎（隔离内核，不参与断言）。 */
const workflowState = {
  run: vi.fn(async () => ({}) as Run),
  resume: vi.fn(async () => ({}) as Run),
  cancel: vi.fn(() => ({ id: "fake-run", status: "canceled" }) as unknown as Run),
};

/**
 * 组装测试用 Fastify 应用：真 DB + 假 workflow/chat + 真 JWT。
 * @returns app 与 deps 句柄
 */
async function buildTestApp() {
  const config = loadSystemConfig({
    rootDir: resolve(process.cwd()),
    override: { runtime: { storage_root: directory } },
  });
  const app = Fastify({ logger: false });
  await registerJwt(app, config, TEST_SECRET);

  const deps: HttpDeps = {
    db: database.db,
    config,
    rootDir: resolve(process.cwd()),
    storageRoot: directory,
    eventBus: createEventBus(),
    workflow: workflowState as unknown as WorkflowEngine,
    chat: {
      send: vi.fn(async () => {}),
      abort: vi.fn(),
    } as unknown as ChatPort,
  };

  registerHttpRoutes(app, deps);
  await app.ready();
  apps.push(app);
  return { app, deps };
}

/** 直接建库内用户（绕过注册），用于构造夹具。 */
function seedUser(username: string, role: "admin" | "user" = "user") {
  return createUser(database.db, {
    username,
    passwordHash: hashPassword(PASSWORD),
    displayName: username,
    role,
  });
}

/** 为指定用户建一个项目与会话（返回 actor / project / session）。 */
function seedProject(user: ReturnType<typeof seedUser>, name: string) {
  const actor: Actor = { userId: user.id, role: user.role };
  const project = createProject(database.db, actor, {
    capabilityId: "video-generation",
    name,
    topic: "主题",
    profile: "landscape-1080p",
  });
  const session = createSession(database.db, actor, { projectId: project.id, title: "会话" });
  return { actor, project, session };
}

beforeEach(async () => {
  workflowState.run.mockClear();
  directory = await mkdtemp(join(tmpdir(), "videoforge-admin-api-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

test("非 admin：GET /api/admin/users 返回 403 AUTH_FORBIDDEN", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("plain");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/users",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("非 admin：POST /api/admin/users/:id/reset-password 返回 403", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("plain");
  const target = seedUser("victim");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "POST",
    url: `/api/admin/users/${target.id}/reset-password`,
    headers: { authorization: `Bearer ${token}` },
    payload: { newPassword: NEW_PASSWORD },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("非 admin：GET /api/admin/projects 返回 403", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("plain");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/projects",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("非 admin：GET /api/admin/runs 返回 403", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("plain");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/runs",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("非 admin：GET /api/admin/runs/:id/trace 返回 403", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("plain");
  const { actor, project, session } = seedProject(user, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "GET",
    url: `/api/admin/runs/${run.id}/trace`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("admin：GET /api/admin/users 返回 200 且响应体不含 password_hash 或明文口令", async () => {
  const { app } = await buildTestApp();
  seedUser("alice");
  const admin = seedUser("root", "admin");
  const token = signAccessToken(app, admin);

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/users",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const users = res.json().users as Array<Record<string, unknown>>;
  expect(users.length).toBeGreaterThanOrEqual(2);
  expect(users[0]).not.toHaveProperty("password_hash");
  expect(res.body).not.toContain("password_hash");
  expect(res.body).not.toContain("scrypt");
  expect(res.body).not.toContain(PASSWORD);
});

test("admin：重置密码 200 且目标 must_change_password=true；目标不存在 400 CONFIG_INVALID", async () => {
  const { app } = await buildTestApp();
  const target = seedUser("victim");
  const admin = seedUser("root", "admin");
  const token = signAccessToken(app, admin);

  const ok = await app.inject({
    method: "POST",
    url: `/api/admin/users/${target.id}/reset-password`,
    headers: { authorization: `Bearer ${token}` },
    payload: { newPassword: NEW_PASSWORD },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ ok: true });
  expect(ok.body).not.toContain(NEW_PASSWORD);

  const updated = findUserById(database.db, target.id);
  expect(updated?.must_change_password).toBe(true);

  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/users/does-not-exist/reset-password",
    headers: { authorization: `Bearer ${token}` },
    payload: { newPassword: NEW_PASSWORD },
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
});

test("admin：GET /api/admin/runs?status=running 只返回该状态的 run", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
    status: "running",
  });
  createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
    status: "done",
  });
  const admin = seedUser("root", "admin");
  const token = signAccessToken(app, admin);

  const res = await app.inject({
    method: "GET",
    url: "/api/admin/runs?status=running",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const runs = res.json().runs as Array<{ status: string }>;
  expect(runs.length).toBe(1);
  expect(runs[0].status).toBe("running");
});

test("admin：GET /api/admin/runs/:id/trace 跨用户返回完整 trace", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  recordToolCall(database.db, actor, {
    sessionId: session.id,
    runId: run.id,
    tool: "copy_generate",
    args: {},
    ok: true,
    durationMs: 1,
  });
  const admin = seedUser("root", "admin");
  const token = signAccessToken(app, admin);

  const res = await app.inject({
    method: "GET",
    url: `/api/admin/runs/${run.id}/trace`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.run.id).toBe(run.id);
  expect(Array.isArray(body.stages)).toBe(true);
  expect(Array.isArray(body.toolCalls)).toBe(true);
  expect(Array.isArray(body.llmCalls)).toBe(true);
  expect(body.total.toolCalls).toBe(1);
  expect(body.paging).toEqual({ limit: 50, offset: 0 });
});
