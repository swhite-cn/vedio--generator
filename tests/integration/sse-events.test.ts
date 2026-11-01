import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
// 测试文件位于仓库根 tests/，根 node_modules 在 pnpm 严格隔离下不暴露 fastify；
// 走 server 工作区本地实例解析（与 apps/server/src 内部 import 'fastify' 指向同一实例）。
import Fastify from "../../apps/server/node_modules/fastify/fastify.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Actor, Run } from "@videoforge/shared";
import { migrateDatabase, createDatabase } from "../../apps/server/src/db";
import { registerJwt, signAccessToken } from "../../apps/server/src/auth/jwt";
import { hashPassword } from "../../apps/server/src/auth/password";
import { createUser } from "../../apps/server/src/db/repositories/user-repository";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { createEventBus } from "../../apps/server/src/http/event-bus";
import { registerHttpRoutes } from "../../apps/server/src/http/index";
import { signEventTicket } from "../../apps/server/src/http/event-ticket";
import type { ChatPort, HttpDeps } from "../../apps/server/src/http/deps";
import type { WorkflowEngine } from "../../apps/server/src/workflow/engine";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/**
 * SSE 会话事件流与短时票据的 HTTP 集成测试（P9-B）。
 * 覆盖鉴权（无凭据/越权）、票据签发与 sid 绑定、真实监听下的快乐路径、以及 Last-Event-ID 重连补发与 resync。
 * 所有等待均带超时，保证测试可自主结束、不挂死。
 */

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const TEST_SECRET = "a".repeat(32);
const PASSWORD = "password123";
const SSE_TIMEOUT_MS = 3000;

let directory: string;
let database: ReturnType<typeof createDatabase>;
const apps: Array<ReturnType<typeof Fastify>> = [];

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

/** 构造两个用户各自的项目与会话（用户隔离夹具）。 */
function seedActors() {
  const userA = createUser(database.db, {
    username: "usa",
    passwordHash: hashPassword(PASSWORD),
    displayName: "A",
    role: "user",
  });
  const userB = createUser(database.db, {
    username: "usb",
    passwordHash: hashPassword(PASSWORD),
    displayName: "B",
    role: "user",
  });
  const actorA: Actor = { userId: userA.id, role: "user" };
  const actorB: Actor = { userId: userB.id, role: "user" };

  const projectA = createProject(database.db, actorA, {
    capabilityId: "video-generation",
    name: "proj-a",
    topic: "主题 A",
    profile: "landscape-1080p",
  });
  const sessionA = createSession(database.db, actorA, { projectId: projectA.id, title: "会话 A" });

  const projectB = createProject(database.db, actorB, {
    capabilityId: "video-generation",
    name: "proj-b",
    topic: "主题 B",
    profile: "landscape-1080p",
  });
  const sessionB = createSession(database.db, actorB, { projectId: projectB.id, title: "会话 B" });

  return { userA, userB, actorA, actorB, projectA, sessionA, projectB, sessionB };
}

/** 让应用监听回环随机端口并返回端口号。 */
async function listen(app: ReturnType<typeof Fastify>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as AddressInfo).port;
}

/** SSE 帧读取器：按 `\n\n` 分帧，逐帧读取并带超时。 */
interface SseReader {
  /** 读取下一帧（超时抛错）。 */
  waitForFrame(timeoutMs?: number): Promise<string>;
  /** 关闭底层流。 */
  close(): Promise<void>;
}

/**
 * 从 fetch 响应构造 SSE 帧读取器。
 * @param response 已就绪的 SSE 响应
 * @returns 帧读取器
 */
function createSseReader(response: Response): SseReader {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async waitForFrame(timeoutMs = SSE_TIMEOUT_MS): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          return frame;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("SSE 帧等待超时");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("SSE 帧等待超时")), remaining);
        });
        try {
          const result = await Promise.race([reader.read(), timeoutPromise]);
          if (result.done) throw new Error("SSE 流已结束");
          buffer += decoder.decode(result.value, { stream: true });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-sse-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

test("SSE：无凭据返回 401", async () => {
  const { app } = await buildTestApp();
  const { sessionA } = seedActors();
  const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionA.id}/events` });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_INVALID" } });
});

test("SSE：用户 B 的 Bearer 访问用户 A 的会话返回 403", async () => {
  const { app } = await buildTestApp();
  const { userB, sessionA } = seedActors();
  const tokenB = signAccessToken(app, userB);
  const res = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionA.id}/events`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("events-ticket：无 token 401；越权 403；成功 200 且 expiresInMs=60000", async () => {
  const { app } = await buildTestApp();
  const { userA, userB, sessionA } = seedActors();
  const tokenA = signAccessToken(app, userA);
  const tokenB = signAccessToken(app, userB);

  const noToken = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionA.id}/events-ticket`,
  });
  expect(noToken.statusCode).toBe(401);

  const forbidden = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionA.id}/events-ticket`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(forbidden.statusCode).toBe(403);

  const ok = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionA.id}/events-ticket`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(ok.statusCode).toBe(200);
  const body = ok.json();
  expect(typeof body.ticket).toBe("string");
  expect(body.expiresInMs).toBe(60000);
});

test("票据 sid 绑定：A 的票据访问 B 的会话返回 401", async () => {
  const { app } = await buildTestApp();
  const { actorA, sessionA, sessionB } = seedActors();
  const ticket = signEventTicket(app, actorA, sessionA.id);

  const res = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionB.id}/events?ticket=${encodeURIComponent(ticket)}`,
  });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_INVALID" } });
});

test("SSE 快乐路径：票据建连并收到事件帧（含 id / event / data）", async () => {
  const { app, deps } = await buildTestApp();
  const { actorA, sessionA } = seedActors();
  const port = await listen(app);
  const ticket = signEventTicket(app, actorA, sessionA.id);
  const url = `http://127.0.0.1:${port}/api/sessions/${sessionA.id}/events?ticket=${encodeURIComponent(ticket)}`;

  const controller = new AbortController();
  const publishTimer = setInterval(() => {
    deps.eventBus.publish(sessionA.id, "run_stage", {
      runId: "run-1",
      stage: "copy",
      status: "running",
      attempt: 0,
    });
  }, 50);
  const hardTimeout = setTimeout(() => controller.abort(), 4000);

  let frame = "";
  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const sse = createSseReader(response);
    frame = await sse.waitForFrame(SSE_TIMEOUT_MS);
    await sse.close();
  } finally {
    clearInterval(publishTimer);
    clearTimeout(hardTimeout);
    controller.abort();
  }

  expect(frame).toContain("event: run_stage");
  expect(frame).toMatch(/(^|\n)id: \d+($|\n)/);
  expect(frame).toContain("data: ");
});

test("SSE 重连：Last-Event-ID 命中时补发其后事件", async () => {
  const { app, deps } = await buildTestApp();
  const { actorA, sessionA } = seedActors();
  const e1 = deps.eventBus.publish(sessionA.id, "text_delta", { text: "a" });
  const e2 = deps.eventBus.publish(sessionA.id, "text_delta", { text: "b" });

  const port = await listen(app);
  const ticket = signEventTicket(app, actorA, sessionA.id);
  const url = `http://127.0.0.1:${port}/api/sessions/${sessionA.id}/events?ticket=${encodeURIComponent(ticket)}`;

  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 4000);
  let frame = "";
  try {
    const response = await fetch(url, {
      headers: { "last-event-id": e1.id },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const sse = createSseReader(response);
    frame = await sse.waitForFrame(SSE_TIMEOUT_MS);
    await sse.close();
  } finally {
    clearTimeout(hardTimeout);
    controller.abort();
  }

  expect(frame).toContain(`id: ${e2.id}`);
  expect(frame).toContain("event: text_delta");
});

test("SSE 重连：Last-Event-ID 未命中先发 resync", async () => {
  const { app } = await buildTestApp();
  const { actorA, sessionA } = seedActors();

  const port = await listen(app);
  const ticket = signEventTicket(app, actorA, sessionA.id);
  const url = `http://127.0.0.1:${port}/api/sessions/${sessionA.id}/events?ticket=${encodeURIComponent(ticket)}`;

  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 4000);
  let frame = "";
  try {
    const response = await fetch(url, {
      headers: { "last-event-id": "999999" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const sse = createSseReader(response);
    frame = await sse.waitForFrame(SSE_TIMEOUT_MS);
    await sse.close();
  } finally {
    clearTimeout(hardTimeout);
    controller.abort();
  }

  expect(frame).toContain("event: resync");
  expect(frame).toContain("buffer-miss");
});
