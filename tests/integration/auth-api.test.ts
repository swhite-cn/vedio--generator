import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// 测试文件位于仓库根 tests/，根 node_modules 在 pnpm 严格隔离下不暴露 fastify；
// 走 server 工作区本地实例解析（与 apps/server/src 内部 import 'fastify' 指向同一实例）。
import Fastify from "../../apps/server/node_modules/fastify/fastify.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Run } from "@videoforge/shared";
import { migrateDatabase, createDatabase } from "../../apps/server/src/db";
import { registerJwt } from "../../apps/server/src/auth/jwt";
import { hashPassword } from "../../apps/server/src/auth/password";
import { resetLoginThrottle } from "../../apps/server/src/auth/throttle";
import { createUser } from "../../apps/server/src/db/repositories/user-repository";
import { createEventBus } from "../../apps/server/src/http/event-bus";
import { registerHttpRoutes } from "../../apps/server/src/http/index";
import type { ChatPort, HttpDeps } from "../../apps/server/src/http/deps";
import type { WorkflowEngine } from "../../apps/server/src/workflow/engine";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/**
 * 鉴权 / 用户 / 能力路由的 HTTP 集成测试（P9-B）。
 * 用真实 SQLite 临时库 + 真实 Fastify 应用（注入假 workflow/chat）覆盖 register/login/me/password、
 * 节流、越权语义、404 与能力列表视图。
 */

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const TEST_SECRET = "a".repeat(32);
const PASSWORD = "password123";

let directory: string;
let database: ReturnType<typeof createDatabase>;
const apps: Array<ReturnType<typeof Fastify>> = [];

/**
 * 组装测试用 Fastify 应用：真 DB + 假 workflow/chat + 真 JWT。
 * @returns app 与 deps 句柄
 */
async function buildTestApp(options: { allowRegistration?: boolean } = {}) {
  const config = loadSystemConfig({
    rootDir: resolve(process.cwd()),
    override: {
      runtime: { storage_root: directory },
      server: { allow_registration: options.allowRegistration ?? true },
    },
  });
  const app = Fastify({ logger: false });
  await registerJwt(app, config, TEST_SECRET);

  const deps: HttpDeps = {
    db: database.db,
    config,
    rootDir: resolve(process.cwd()),
    storageRoot: directory,
    eventBus: createEventBus(),
    workflow: {
      run: vi.fn(async () => ({}) as Run),
      resume: vi.fn(),
      cancel: vi.fn(),
    } as unknown as WorkflowEngine,
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

/** 直接建库内用户（绕过注册），用于构造指定状态的测试夹具。 */
function seedUser(username: string, mustChangePassword = false, role: "admin" | "user" = "user") {
  return createUser(database.db, {
    username,
    passwordHash: hashPassword(PASSWORD),
    displayName: username,
    role,
    mustChangePassword,
  });
}

beforeEach(async () => {
  resetLoginThrottle();
  directory = await mkdtemp(join(tmpdir(), "videoforge-auth-api-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

test("注册：关闭开关返回 403 AUTH_FORBIDDEN", async () => {
  const { app } = await buildTestApp({ allowRegistration: false });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "alice", password: PASSWORD },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: { code: "AUTH_FORBIDDEN", message: expect.any(String) } });
});

test("注册：成功返回 201 且响应体不含密码哈希或明文口令", async () => {
  const { app } = await buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Alice", password: PASSWORD, displayName: "爱丽丝" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.user).toMatchObject({
    username: "alice",
    display_name: "爱丽丝",
    role: "user",
    must_change_password: false,
  });
  expect(body.user).not.toHaveProperty("password_hash");
  expect(res.body).not.toContain(PASSWORD);
  expect(res.body).not.toContain("scrypt");
});

test("注册：保留名 admin 与重复用户名返回完全相同错误", async () => {
  const { app } = await buildTestApp();

  const adminRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "admin", password: PASSWORD },
  });
  expect(adminRes.statusCode).toBe(403);

  const first = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "bob", password: PASSWORD },
  });
  expect(first.statusCode).toBe(201);

  const dupRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "BOB", password: PASSWORD },
  });
  expect(dupRes.statusCode).toBe(403);

  // 两类错误文案与错误码一致（不通过差异暴露「保留名」）
  expect(adminRes.json()).toEqual(dupRes.json());
});

test("登录：错误口令 401；连续 5 次失败后第 6 次即使口令正确也 401", async () => {
  const { app } = await buildTestApp();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "carol", password: PASSWORD },
  });

  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "carol", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  }

  const throttled = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "carol", password: PASSWORD },
  });
  expect(throttled.statusCode).toBe(401);
});

test("登录：成功返回 200 且含 token 与 user（无哈希）", async () => {
  const { app } = await buildTestApp();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "dave", password: PASSWORD },
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "dave", password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(typeof body.token).toBe("string");
  expect(body.token.length).toBeGreaterThan(0);
  expect(body.user.username).toBe("dave");
  expect(body.user).not.toHaveProperty("password_hash");
  expect(res.body).not.toContain(PASSWORD);
});

test("GET /api/auth/me：无 token 401；带 token 200；must_change_password 透传", async () => {
  const { app } = await buildTestApp();
  seedUser("eve", true);

  const noToken = await app.inject({ method: "GET", url: "/api/auth/me" });
  expect(noToken.statusCode).toBe(401);
  expect(noToken.json()).toMatchObject({ error: { code: "AUTH_INVALID" } });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "eve", password: PASSWORD },
  });
  const token = login.json().token as string;

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json().user).toMatchObject({ username: "eve", must_change_password: true });
});

test("POST /api/auth/password：无 token 401；当前口令错 401；成功后旧口令失效、新口令生效", async () => {
  const { app } = await buildTestApp();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "frank", password: PASSWORD },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "frank", password: PASSWORD },
  });
  const token = login.json().token as string;

  const noToken = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { currentPassword: PASSWORD, newPassword: "newpassword1" },
  });
  expect(noToken.statusCode).toBe(401);

  const wrongCurrent = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: "not-the-password", newPassword: "newpassword1" },
  });
  expect(wrongCurrent.statusCode).toBe(401);

  const ok = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: PASSWORD, newPassword: "newpassword1" },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ ok: true });
  expect(ok.body).not.toContain("newpassword1");

  resetLoginThrottle();
  const oldLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "frank", password: PASSWORD },
  });
  expect(oldLogin.statusCode).toBe(401);

  const newLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "frank", password: "newpassword1" },
  });
  expect(newLogin.statusCode).toBe(200);
});

test("未知路径返回 404 NOT_FOUND", async () => {
  const { app } = await buildTestApp();
  const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "资源不存在" } });
});

test("GET /api/capabilities：无 token 401；带 token 200 且剥离 paramsSchema", async () => {
  const { app } = await buildTestApp();
  seedUser("grace");

  const noToken = await app.inject({ method: "GET", url: "/api/capabilities" });
  expect(noToken.statusCode).toBe(401);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "grace", password: PASSWORD },
  });
  const token = login.json().token as string;

  const res = await app.inject({
    method: "GET",
    url: "/api/capabilities",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const capabilities = res.json().capabilities as Array<Record<string, unknown>>;
  expect(capabilities[0].id).toBe("video-generation");
  expect(capabilities[0]).not.toHaveProperty("paramsSchema");
});
