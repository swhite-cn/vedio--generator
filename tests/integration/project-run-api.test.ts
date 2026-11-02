import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { createUser } from "../../apps/server/src/db/repositories/user-repository";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { createRun, getRun, listRuns } from "../../apps/server/src/db/repositories/run-repository";
import {
  createRunStage,
  updateRunStage,
} from "../../apps/server/src/db/repositories/run-stage-repository";
import { recordToolCall } from "../../apps/server/src/db/repositories/trace-repository";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";
import { createEventBus } from "../../apps/server/src/http/event-bus";
import { registerHttpRoutes } from "../../apps/server/src/http/index";
import type { ChatPort, HttpDeps } from "../../apps/server/src/http/deps";
import type { WorkflowEngine } from "../../apps/server/src/workflow/engine";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/**
 * runs / trace / artifacts / media 路由的 HTTP 集成测试（P9-C）。
 * 用真实 SQLite 临时库 + 真实 Fastify 应用（注入假 workflow/chat）覆盖：
 * 鉴权、跨用户越权语义、发起 / 查询 / 恢复 / 取消 run、trace 分页、产物索引与受限媒体读取。
 */

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const TEST_SECRET = "a".repeat(32);
const PASSWORD = "password123";

let directory: string;
let database: ReturnType<typeof createDatabase>;
const apps: Array<ReturnType<typeof Fastify>> = [];

/**
 * 假工作流引擎：记录调用并返回占位结果（隔离内核）。
 * 供断言「非阻塞触发确实被调用」。
 */
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
  workflowState.resume.mockClear();
  workflowState.cancel.mockClear();
  directory = await mkdtemp(join(tmpdir(), "videoforge-run-api-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

test("GET /api/projects/:id/runs：无 token 返回 401 AUTH_INVALID", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("ua");
  const { project } = seedProject(user, "pa");

  const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/runs` });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_INVALID" } });
});

test("GET /api/projects/:id/runs：用户 B 访问用户 A 的项目返回 403 AUTH_FORBIDDEN", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const userB = seedUser("ub");
  const { project } = seedProject(userA, "pa");
  const tokenB = signAccessToken(app, userB);

  const res = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("GET /api/projects/:id/runs：本人返回 200 且 runs 为数组", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { project } = seedProject(userA, "pa");
  const tokenA = signAccessToken(app, userA);

  const res = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json().runs)).toBe(true);
});

test("POST /api/projects/:id/runs：成功 201、run 落库且非阻塞触发工作流", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  const tokenA = signAccessToken(app, userA);

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { sessionId: session.id },
  });
  expect(res.statusCode).toBe(201);
  const runId = res.json().run.id as string;
  expect(typeof runId).toBe("string");
  // run 已落库
  expect(getRun(database.db, actor, runId)).toBeTruthy();
  expect(listRuns(database.db, actor, project.id).some((r) => r.id === runId)).toBe(true);
  // 非阻塞触发是微任务，带超时等待（不会挂死）
  await vi.waitFor(() => expect(workflowState.run).toHaveBeenCalled());
});

test("POST /api/projects/:id/runs：项目已有活跃 run 返回 409 PROJECT_BUSY", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
    status: "running",
  });
  const tokenA = signAccessToken(app, userA);

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {},
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: { code: "PROJECT_BUSY" } });
});

test("GET /api/runs/:id：本人返回 200 且含 run 与 stages 数组", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  const tokenA = signAccessToken(app, userA);

  const res = await app.inject({
    method: "GET",
    url: `/api/runs/${run.id}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.run.id).toBe(run.id);
  expect(Array.isArray(body.stages)).toBe(true);
});

test("GET /api/runs/:id：跨用户返回 403 AUTH_FORBIDDEN", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const userB = seedUser("ub");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  const tokenB = signAccessToken(app, userB);

  const res = await app.inject({
    method: "GET",
    url: `/api/runs/${run.id}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("POST /api/runs/:id/resume：非法 action 400；approve 202 且触发引擎", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  const tokenA = signAccessToken(app, userA);

  const bogus = await app.inject({
    method: "POST",
    url: `/api/runs/${run.id}/resume`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { action: "bogus" },
  });
  expect(bogus.statusCode).toBe(400);
  expect(bogus.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });

  const ok = await app.inject({
    method: "POST",
    url: `/api/runs/${run.id}/resume`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { action: "approve" },
  });
  expect(ok.statusCode).toBe(202);
  expect(ok.json().run.id).toBe(run.id);
  await vi.waitFor(() => expect(workflowState.resume).toHaveBeenCalled());
});

test("POST /api/runs/:id/cancel：跨用户 403；本人 200 且含 run", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const userB = seedUser("ub");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  const tokenA = signAccessToken(app, userA);
  const tokenB = signAccessToken(app, userB);

  const forbidden = await app.inject({
    method: "POST",
    url: `/api/runs/${run.id}/cancel`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });

  const ok = await app.inject({
    method: "POST",
    url: `/api/runs/${run.id}/cancel`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().run).toBeTruthy();
});

test("GET /api/runs/:id/trace：含 stages/toolCalls/llmCalls/total/paging，分页参数生效", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa");
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
  });
  // 造 2 条工具调用留痕，验证切片与总数
  recordToolCall(database.db, actor, {
    sessionId: session.id,
    runId: run.id,
    tool: "copy_generate",
    args: {},
    ok: true,
    durationMs: 1,
  });
  recordToolCall(database.db, actor, {
    sessionId: session.id,
    runId: run.id,
    tool: "image_generate",
    args: {},
    ok: true,
    durationMs: 2,
  });
  const tokenA = signAccessToken(app, userA);
  const headers = { authorization: `Bearer ${tokenA}` };

  const res = await app.inject({ method: "GET", url: `/api/runs/${run.id}/trace`, headers });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(Array.isArray(body.stages)).toBe(true);
  expect(Array.isArray(body.toolCalls)).toBe(true);
  expect(Array.isArray(body.llmCalls)).toBe(true);
  expect(body.total.toolCalls).toBe(2);
  expect(body.total.llmCalls).toBe(0);
  expect(body.paging.limit).toBe(50);
  expect(body.paging.offset).toBe(0);
  expect(body.toolCalls.length).toBe(2);

  const paged = await app.inject({
    method: "GET",
    url: `/api/runs/${run.id}/trace?limit=1&offset=1`,
    headers,
  });
  expect(paged.statusCode).toBe(200);
  expect(paged.json().paging).toEqual({ limit: 1, offset: 1 });
  expect(paged.json().toolCalls.length).toBe(1);
  expect(paged.json().total.toolCalls).toBe(2);

  const invalid = await app.inject({
    method: "GET",
    url: `/api/runs/${run.id}/trace?limit=abc`,
    headers,
  });
  expect(invalid.statusCode).toBe(200);
  expect(invalid.json().paging.limit).toBe(50);
});

test("GET /api/projects/:id/artifacts：本人空目录 200；跨用户 403", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const userB = seedUser("ub");
  const { project } = seedProject(userA, "pa");
  const tokenA = signAccessToken(app, userA);
  const tokenB = signAccessToken(app, userB);

  const ok = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/artifacts`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().artifacts.finalVideoExists).toBe(false);
  expect(Array.isArray(ok.json().artifacts.entries)).toBe(true);

  const forbidden = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/artifacts`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});

test("GET /api/media/*：越界 403、缺失 404、本人存在文件 200", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const userB = seedUser("ub");
  const { actor, project } = seedProject(userA, "proj-media");
  const tokenA = signAccessToken(app, userA);
  const headers = { authorization: `Bearer ${tokenA}` };

  // 越界：目标逃出当前用户根目录
  const traversal = await app.inject({
    method: "GET",
    url: "/api/media/..%2F..%2Fsecret.txt",
    headers,
  });
  expect(traversal.statusCode).toBe(403);
  expect(traversal.json()).toMatchObject({ error: { code: "PATH_OUTSIDE_STORAGE" } });

  // 指向其它用户目录：同样拒绝
  const otherUser = await app.inject({
    method: "GET",
    url: `/api/media/users/${userB.id}/projects/proj-b/secret.txt`,
    headers,
  });
  expect(otherUser.statusCode).toBe(403);
  expect(otherUser.json()).toMatchObject({ error: { code: "PATH_OUTSIDE_STORAGE" } });

  const base = `users/${userA.id}/projects/${project.name}`;

  // 本人目录下不存在的文件
  const missing = await app.inject({
    method: "GET",
    url: `/api/media/${base}/missing.txt`,
    headers,
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

  // 本人目录下真实文件
  const projectDir = resolveUserProjectDir(directory, actor.userId, project.name);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "note.txt"), "hello-media", "utf-8");

  const found = await app.inject({
    method: "GET",
    url: `/api/media/${base}/note.txt`,
    headers,
  });
  expect(found.statusCode).toBe(200);
  expect(String(found.headers["content-type"])).toContain("text/plain");
  expect(found.body).toBe("hello-media");
});

test("POST /api/media/ticket：票据可读媒体、支持 Range 206、无凭据 401", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project } = seedProject(userA, "proj-media-ticket");
  const tokenA = signAccessToken(app, userA);
  const base = `users/${actor.userId}/projects/${project.name}`;

  const projectDir = resolveUserProjectDir(directory, actor.userId, project.name);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "clip.mp4"), "0123456789", "utf-8");

  // 签发媒体票据（原生 img/video 标签无法带 Authorization，改用它）
  const ticketRes = await app.inject({
    method: "POST",
    url: "/api/media/ticket",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(ticketRes.statusCode).toBe(200);
  const ticket = ticketRes.json().ticket as string;
  expect(typeof ticket).toBe("string");
  expect(ticket.length).toBeGreaterThan(0);

  const viaTicket = await app.inject({
    method: "GET",
    url: `/api/media/${base}/clip.mp4?ticket=${encodeURIComponent(ticket)}`,
  });
  expect(viaTicket.statusCode).toBe(200);
  expect(viaTicket.body).toBe("0123456789");
  expect(String(viaTicket.headers["accept-ranges"])).toBe("bytes");

  // 场景文件在工作台预览模式下从暂停时间轴自动开始；原始文件不被改写。
  mkdirSync(join(projectDir, "scenes"), { recursive: true });
  writeFileSync(
    join(projectDir, "scenes", "s1.html"),
    "<html><body><script>window.__videoforgeTimeline={restart:function(){}};</script></body></html>",
    "utf-8",
  );
  const scenePreview = await app.inject({
    method: "GET",
    url: `/api/media/${base}/scenes/s1.html?ticket=${encodeURIComponent(ticket)}&preview=1`,
  });
  expect(scenePreview.statusCode).toBe(200);
  expect(scenePreview.body).toContain("timeline.restart()");
  expect(scenePreview.body).toContain("</body>");

  // 视频播放依赖 Range/206
  const ranged = await app.inject({
    method: "GET",
    url: `/api/media/${base}/clip.mp4?ticket=${encodeURIComponent(ticket)}`,
    headers: { range: "bytes=2-5" },
  });
  expect(ranged.statusCode).toBe(206);
  expect(String(ranged.headers["content-range"])).toBe("bytes 2-5/10");
  expect(ranged.rawPayload.toString()).toBe("2345");

  // 无任何凭据仍拒绝
  const anonymous = await app.inject({ method: "GET", url: `/api/media/${base}/clip.mp4` });
  expect(anonymous.statusCode).toBe(401);
  expect(anonymous.json()).toMatchObject({ error: { code: "AUTH_INVALID" } });

  // 票据不能当作 access token 访问其它接口（用途隔离）
  const isolated = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${ticket}` },
  });
  expect(isolated.statusCode).toBe(401);
});

test("GET /api/runs/:id：阶段产物已存在时把失败阶段校正为已完成", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "proj-reconcile");
  const tokenA = signAccessToken(app, userA);

  // 复现现场：run 以 failed 收场，tts 阶段记录 ARTIFACT_MISSING，
  // 但用户随后在对话里补跑并生成了音频（自由对话不写 run_stages）
  const run = createRun(database.db, actor, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
    status: "failed",
  });
  const stage = createRunStage(database.db, actor, {
    runId: run.id,
    stage: "tts",
    attempt: 0,
    status: "failed",
  });
  updateRunStage(database.db, actor, stage.id, {
    status: "failed",
    errorCode: "ARTIFACT_MISSING",
  });

  const projectDir = resolveUserProjectDir(directory, actor.userId, project.name);
  mkdirSync(join(projectDir, "audio"), { recursive: true });
  writeFileSync(join(projectDir, "audio", "s1.mp3"), "fake-mp3");

  const res = await app.inject({
    method: "GET",
    url: `/api/runs/${run.id}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(res.statusCode).toBe(200);
  const tts = (
    res.json().stages as Array<{ stage: string; status: string; error_code: string | null }>
  ).find((row) => row.stage === "tts");
  expect(tts?.status).toBe("done");
  expect(tts?.error_code).toBeNull();
  // 只做视图校正：数据库里的原始失败结论保持不变（追加式审计）
  expect(getRun(database.db, actor, run.id)?.status).toBe("failed");
});
