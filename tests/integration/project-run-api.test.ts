import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { createProjectAsset } from "../../apps/server/src/db/repositories/asset-repository";
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
import {
  buildAudioCuesDoc,
  buildShotSpecs,
  ensureThemeSnapshot,
  loadTheme,
  mergeSceneSpecShots,
  parseCopyV2Json,
  writeAudioCues,
  writeCopyDoc,
  writeCopyDocV2,
  writeSceneSpec,
  writeTimelineV2,
} from "../../packages/pipeline/src/index";
import { writeFixtureCopyV2, writeFixtureCues } from "../unit/helpers/v2-project-fixture";

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

/**
 * 为指定用户建一个项目与会话（返回 actor / project / session）。
 * @param user 已建库的用户
 * @param name 项目名
 * @param contractVersion 契约版本；默认 `1.0`（存量项目），可传 `2.0` 构造可续跑项目
 */
function seedProject(
  user: ReturnType<typeof seedUser>,
  name: string,
  contractVersion = "1.0",
) {
  const actor: Actor = { userId: user.id, role: user.role };
  const project = createProject(database.db, actor, {
    capabilityId: "video-generation",
    name,
    topic: "主题",
    profile: "landscape-1080p",
    contractVersion,
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

test("POST /api/projects：带 themeId 创建项目并写入主题快照", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("ut");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      capabilityId: "video-generation",
      topic: "水银的两面",
      themeId: "documentary-dark",
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().project.theme_id).toBe("documentary-dark");

  const projectDir = resolveUserProjectDir(directory, user.id, res.json().project.name);
  const snapshotPath = join(projectDir, "theme.resolved.json");
  expect(existsSync(snapshotPath)).toBe(true);
  expect(JSON.parse(readFileSync(snapshotPath, "utf-8")).themeId).toBe("documentary-dark");
});

test("POST /api/projects：未知 themeId 返回 CONFIG_INVALID", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("ut2");
  const token = signAccessToken(app, user);

  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: { capabilityId: "video-generation", topic: "主题", themeId: "no-such-theme" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
});

test("GET /api/projects：返回服务端派生指标与最新 run（方案 §7.5）", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("umetrics");
  const { project } = seedProject(user, "metrics");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);

  seedCopyV2(projectDir);
  writeTimelineV2(join(projectDir, "timeline.json"), {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 500,
    timingSource: "estimated",
    totalMs: 6500,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 3000, durationMs: 3000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 3000, endMs: 6000, durationMs: 3000 },
    ],
    cues: [],
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const row = res.json().projects.find((item: { id: string }) => item.id === project.id);
  expect(row).toMatchObject({
    shotCount: 2,
    totalMs: 6500,
    averageShotMs: 3000,
    boundShotCount: 0,
    progress: 0,
    etaSeconds: null,
    latestRun: null,
  });

  const detail = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().project).toMatchObject({
    shotCount: 2,
    totalMs: 6500,
    averageShotMs: 3000,
    boundShotCount: 0,
    latestRun: null,
  });
});

test("GET /api/components 与 /api/themes：只读目录与错误口径", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("ucatalog");
  const token = signAccessToken(app, user);
  const headers = { authorization: `Bearer ${token}` };

  const components = await app.inject({
    method: "GET",
    url: "/api/components",
    headers,
  });
  expect(components.statusCode).toBe(200);
  const items = components.json().items;
  expect(items.length).toBeGreaterThanOrEqual(3);
  expect(items.map((item: { id: string }) => item.id)).toEqual(
    expect.arrayContaining(["keyword-block", "data-card", "quote-card"]),
  );
  const keywordBlock = items.find((item: { id: string }) => item.id === "keyword-block");
  expect(keywordBlock).toMatchObject({ name: "关键词块", category: "text" });
  expect(keywordBlock.paramsSchema.title).toMatchObject({ type: "string", required: true });
  expect(components.headers["cache-control"]).toContain("max-age=");

  const preview = await app.inject({
    method: "GET",
    url: "/api/components/keyword-block/preview",
    headers,
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().fixture).toMatchObject({ componentId: "keyword-block" });

  const unknownPreview = await app.inject({
    method: "GET",
    url: "/api/components/no-such-component/preview",
    headers,
  });
  expect(unknownPreview.statusCode).toBe(400);
  expect(unknownPreview.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });

  const themes = await app.inject({
    method: "GET",
    url: "/api/themes",
    headers,
  });
  expect(themes.statusCode).toBe(200);
  expect(themes.json().items.map((item: { id: string }) => item.id)).toContain(
    "documentary-dark",
  );

  const theme = await app.inject({
    method: "GET",
    url: "/api/themes/documentary-dark",
    headers,
  });
  expect(theme.statusCode).toBe(200);
  expect(theme.json().theme).toMatchObject({ id: "documentary-dark" });

  const unknownTheme = await app.inject({
    method: "GET",
    url: "/api/themes/no-such-theme",
    headers,
  });
  expect(unknownTheme.statusCode).toBe(400);
  expect(unknownTheme.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
});

test("GET /api/projects/:id/storyboard：聚合 shots/cues/theme/spec/quality", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("ustory");
  const { project } = seedProject(user, "story");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  mkdirSync(projectDir, { recursive: true });

  const copy = parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [{ key: "mercury", label: "水银", color: "#C9CED6" }],
      scenes: [
        {
          sceneId: "s1",
          chapterNo: 1,
          title: "开场",
          shots: [
            {
              shotId: "sh-001",
              narration: "第一句。第二句。",
              onScreenText: "水银 → 黄金",
              visualType: "component",
              anchorKeys: ["mercury"],
            },
            { shotId: "sh-002", narration: "第三句。", visualType: "image" },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
  );
  writeCopyDocV2(join(projectDir, "copy.json"), copy);

  writeAudioCues(
    join(projectDir, "audio", "cues.json"),
    buildAudioCuesDoc({
      timingSource: "estimated",
      shots: [
        {
          shotId: "sh-001",
          sceneId: "s1",
          audioPath: "audio/sh-001.mp3",
          durationMs: 4000,
          narration: "第一句。第二句。",
        },
        {
          shotId: "sh-002",
          sceneId: "s1",
          audioPath: "audio/sh-002.mp3",
          durationMs: 2500,
          narration: "第三句。",
        },
      ],
    }),
  );

  const theme = loadTheme({ rootDir: resolve(process.cwd()), themeId: "documentary-dark" });
  ensureThemeSnapshot(projectDir, theme);
  writeSceneSpec(
    projectDir,
    mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [] }).shots,
      copy.theme.id,
    ),
  );
  mkdirSync(join(projectDir, "quality"), { recursive: true });
  writeFileSync(
    join(projectDir, "quality", "report.json"),
    readFileSync(
      join(resolve(process.cwd()), "tests", "fixtures", "contracts-v2", "quality-report.json"),
      "utf-8",
    ),
    "utf-8",
  );

  const res = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/storyboard`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({
    contractVersion: "2.0",
    project: { id: project.id },
  });
  expect(body.shots).toHaveLength(2);
  expect(body.shots[0]).toMatchObject({ shotId: "sh-001", sceneId: "s1", sceneTitle: "开场" });
  expect(body.cues).toHaveLength(3);
  expect(body.theme.themeId).toBe("documentary-dark");
  expect(body.spec.shots).toHaveLength(2);
  expect(body.assets).toEqual([]);
  expect(body.quality.checks).toHaveLength(5);
});

test("GET /api/projects/:id/storyboard：跨用户 403，空项目返回空数组", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua-story");
  const userB = seedUser("ub-story");
  const { project } = seedProject(userA, "pa-story");
  const tokenA = signAccessToken(app, userA);
  const tokenB = signAccessToken(app, userB);

  const own = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/storyboard`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  expect(own.statusCode).toBe(200);
  expect(own.json().shots).toEqual([]);
  expect(own.json().cues).toEqual([]);

  const forbidden = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/storyboard`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(forbidden.statusCode).toBe(403);
});

test("GET /api/projects/:id/quality：报告存在返回 report+summary，缺失返回 null（T207）", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uquality");
  const { project } = seedProject(user, "pq");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);

  // 未跑过质检：report/summary 为 null，不视为错误
  const empty = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/quality`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ projectId: project.id, report: null, summary: null });

  // 落盘一份报告：返回报告与服务端汇总
  mkdirSync(join(projectDir, "quality"), { recursive: true });
  writeFileSync(
    join(projectDir, "quality", "report.json"),
    readFileSync(
      join(resolve(process.cwd()), "tests", "fixtures", "contracts-v2", "quality-report.json"),
      "utf-8",
    ),
    "utf-8",
  );
  const res = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/quality`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.projectId).toBe(project.id);
  expect(body.report.checks).toHaveLength(5);
  expect(body.summary).toMatchObject({ failed: expect.any(Number), blocking: expect.any(Boolean) });

  // 跨用户 403
  const other = seedUser("uquality-b");
  const tokenB = signAccessToken(app, other);
  const forbidden = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/quality`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  expect(forbidden.statusCode).toBe(403);
});

test("GET /api/player/:projectId/:shotId：内联渲染数据 HTML，产物缺失走错误态（T208）", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uplayer");
  const { project } = seedProject(user, "player");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);
  // Player 需要的最小渲染产物：timeline v2 + 主题快照
  writeFileSync(
    join(projectDir, "timeline.json"),
    JSON.stringify({
      contractVersion: "2.0",
      fps: 30,
      tailPauseMs: 0,
      timingSource: "estimated",
      totalMs: 2000,
      shots: [
        { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
        { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
      ],
      cues: [],
    }),
    "utf-8",
  );
  const theme = loadTheme({ rootDir: resolve(process.cwd()), themeId: "documentary-dark" });
  ensureThemeSnapshot(projectDir, theme);

  // 单镜头预览：内联数据带 shotId 与全量渲染输入
  const res = await app.inject({
    method: "GET",
    url: `/api/player/${project.id}/sh-001`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  const html = res.body;
  expect(html).toContain("window.__PLAYER_DATA__");
  expect(html).toContain('"shotId":"sh-001"');
  expect(html).toContain('src="/player/player.js"');
  expect(html).toContain("timeline");

  // 产物缺失（无 copy/timeline/theme）时内联 error，不 500（不白屏语义）
  const bareUser = seedUser("uplayer-bare");
  const bare = seedProject(bareUser, "player-bare");
  const bareRes = await app.inject({
    method: "GET",
    url: `/api/player/${bare.project.id}`,
    headers: { authorization: `Bearer ${signAccessToken(app, bareUser)}` },
  });
  expect(bareRes.statusCode).toBe(200);
  expect(bareRes.body).toContain("error");

  // 跨用户 403
  const other = seedUser("uplayer-other");
  const forbidden = await app.inject({
    method: "GET",
    url: `/api/player/${project.id}/sh-001`,
    headers: { authorization: `Bearer ${signAccessToken(app, other)}` },
  });
  expect(forbidden.statusCode).toBe(403);
});

/** 为指定项目目录写入 copy v2 夹具（2 个镜头）。 */
function seedCopyV2(projectDir: string, themeId = "documentary-dark") {
  mkdirSync(projectDir, { recursive: true });
  const copy = parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [{ key: "mercury", label: "水银", color: "#C9CED6" }],
      scenes: [
        {
          sceneId: "s1",
          chapterNo: 1,
          title: "开场",
          shots: [
            {
              shotId: "sh-001",
              narration: "第一句。",
              onScreenText: "水银 → 黄金",
              visualType: "component",
              transitionIn: "title-card",
            },
            { shotId: "sh-002", narration: "第二句。", visualType: "image" },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId },
  );
  writeCopyDocV2(join(projectDir, "copy.json"), copy);
  return copy;
}

test("PATCH /api/projects/:id/shots/:shotId：修改屏上文字并记录可逆动作", async () => {
  const { app, deps } = await buildTestApp();
  const user = seedUser("upatch");
  const { project, session } = seedProject(user, "patch");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);

  // 订阅项目会话事件流，验证 shot.updated（方案 §7.2）与 resync 兼容
  const seen: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
  const unsubscribe = deps.eventBus.subscribe(session.id, (event) =>
    seen.push({ id: event.id, type: event.type, payload: event.payload }),
  );

  const res = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/shots/sh-001`,
    headers: { authorization: `Bearer ${token}` },
    payload: { changes: { onScreenText: "新的屏上文字", transitionOut: "fade-120" } },
  });
  unsubscribe();

  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.shot).toMatchObject({
    shotId: "sh-001",
    onScreenText: "新的屏上文字",
    transitionOut: "fade-120",
  });
  expect(body.action).toMatchObject({ kind: "reversible_edit", status: "done" });
  expect(body.action.plan_json).toMatchObject({
    action: "shot.patch",
    shotId: "sh-001",
    before: { onScreenText: "水银 → 黄金", transitionOut: "hard-cut" },
    after: { onScreenText: "新的屏上文字", transitionOut: "fade-120" },
  });

  const copyOnDisk = JSON.parse(readFileSync(join(projectDir, "copy.json"), "utf-8"));
  expect(copyOnDisk.scenes[0].shots[0].onScreenText).toBe("新的屏上文字");
  expect(copyOnDisk.scenes[0].shots[0].transitionOut).toBe("fade-120");
  expect(copyOnDisk.scenes[0].shots[1].onScreenText).toBe("");

  // SSE：agent_action 与 shot.updated 均下发
  const types = seen.map((event) => event.type);
  expect(types).toContain("agent_action");
  expect(types).toContain("shot.updated");
  const shotUpdated = seen.find((event) => event.type === "shot.updated");
  expect(shotUpdated?.payload).toMatchObject({
    projectId: project.id,
    shotId: "sh-001",
    specUpdated: false,
  });

  // Last-Event-ID 命中：续传其后事件；未命中：resync
  const lastEventId = seen[seen.length - 1].id;
  const replayed = deps.eventBus.replay(session.id, lastEventId);
  expect(replayed.resync).toBe(false);
  expect(replayed.events).toEqual([]);
  expect(deps.eventBus.replay(session.id, "999999").resync).toBe(true);
});

test("PATCH shots：非法组件/未知镜头返回 CONFIG_INVALID，copy 不变", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("upatch-bad");
  const { project } = seedProject(user, "patch-bad");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);
  const before = readFileSync(join(projectDir, "copy.json"), "utf-8");

  const badComponent = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/shots/sh-002`,
    headers: { authorization: `Bearer ${token}` },
    payload: { changes: { component: { id: "data-card", params: { label: "缺值" } } } },
  });
  expect(badComponent.statusCode).toBe(400);
  expect(badComponent.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });

  const unknownShot = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/shots/sh-999`,
    headers: { authorization: `Bearer ${token}` },
    payload: { changes: { onScreenText: "x" } },
  });
  expect(unknownShot.statusCode).toBe(400);
  expect(unknownShot.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });

  expect(readFileSync(join(projectDir, "copy.json"), "utf-8")).toBe(before);
});

test("PATCH shots：跨用户 403；v1 项目拒绝编辑", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("upatch-a");
  const userB = seedUser("upatch-b");
  const { project } = seedProject(userA, "patch-auth");
  const projectDir = resolveUserProjectDir(directory, userA.id, project.name);
  seedCopyV2(projectDir);
  const tokenA = signAccessToken(app, userA);
  const tokenB = signAccessToken(app, userB);

  const forbidden = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/shots/sh-001`,
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { changes: { onScreenText: "越权" } },
  });
  expect(forbidden.statusCode).toBe(403);

  // 把 copy 换回 v1，验证 v1 项目被明确拒绝
  mkdirSync(projectDir, { recursive: true });
  writeCopyDoc(join(projectDir, "copy.json"), {
    topic: "黑洞",
    style: "科普",
    title: "黑洞不是洞",
    scenes: [{ sceneId: "s1", title: "引入", narration: "黑洞不是洞。", imagePrompt: "插画" }],
  });
  const legacy = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/shots/s1`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { changes: { onScreenText: "x" } },
  });
  expect(legacy.statusCode).toBe(400);
  expect(legacy.json().error.message).toContain("仅契约 v2");
});

test("POST /api/projects/:id/shots/:shotId/regenerate：202 且 run 带 scope", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uregen");
  const { project } = seedProject(user, "regen");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/shots/sh-002/regenerate`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stages: ["image"], instruction: "改为夜景" },
  });
  expect(res.statusCode).toBe(202);
  const body = res.json();
  expect(body.run.scope_json).toEqual({ shotIds: ["sh-002"], fromStage: "image" });
  expect(body.action).toMatchObject({ kind: "regenerate", status: "executing" });
  expect(body.action.run_id).toBe(body.run.id);
  expect(body.action.plan_json).toMatchObject({
    action: "shot.regenerate",
    shotId: "sh-002",
    stages: ["image"],
    instruction: "改为夜景",
  });
  // 非阻塞触发工作流
  expect(workflowState.run).toHaveBeenCalled();
});

test("POST regenerate：未知镜头 / 空阶段返回 CONFIG_INVALID", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uregen-bad");
  const { project } = seedProject(user, "regen-bad");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);

  const unknownShot = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/shots/sh-999/regenerate`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stages: ["image"] },
  });
  expect(unknownShot.statusCode).toBe(400);
  expect(unknownShot.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });

  const emptyStages = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/shots/sh-001/regenerate`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stages: [] },
  });
  expect(emptyStages.statusCode).toBe(400);

  const copyStage = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/shots/sh-001/regenerate`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stages: ["copy"] },
  });
  expect(copyStage.statusCode).toBe(400);
});

test("POST regenerate：项目已有活跃 run 时返回 409 PROJECT_BUSY", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uregen-busy");
  const { project, session } = seedProject(user, "regen-busy");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopyV2(projectDir);

  // 手动占用项目租约
  createRun(database.db, { userId: user.id, role: user.role }, {
    projectId: project.id,
    sessionId: session.id,
    trigger: "user",
    status: "running",
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/shots/sh-001/regenerate`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stages: ["image"] },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: { code: "PROJECT_BUSY" } });
});

test("GET /api/projects/:id/assets：返回分类枚举与 copy v2 计算的绑定镜头数", async () => {
  const { app } = await buildTestApp();
  const user = seedUser("uassets");
  const { actor, project } = seedProject(user, "assets-bindings");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);

  // 两条资产记录：锚点归档照 + ai 叠加图（id 与 copy v2 中的 assetId 对齐）
  createProjectAsset(database.db, actor, {
    id: "asset-anchor",
    projectId: project.id,
    source: "uploaded",
    kind: "image",
    visualCategory: "archive-photo",
    label: "水银档案.jpg",
    relativePath: "assets/uploads/水银档案.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 256,
  });
  createProjectAsset(database.db, actor, {
    id: "asset-b",
    projectId: project.id,
    source: "uploaded",
    kind: "image",
    visualCategory: "ai-generated",
    label: "叠加图.png",
    relativePath: "assets/uploads/叠加图.png",
    mimeType: "image/png",
    sizeBytes: 128,
  });

  // copy v2：锚点 mercury 绑定 archive 资产，sh-001 引用两者，sh-002 再引锚点资产
  mkdirSync(projectDir, { recursive: true });
  const copy = parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [
        { key: "mercury", label: "水银", color: "#C9CED6", assetId: "asset-anchor" },
      ],
      scenes: [
        {
          sceneId: "s1",
          chapterNo: 1,
          title: "开场",
          shots: [
            {
              shotId: "sh-001",
              narration: "第一句。",
              visualType: "image",
              assetRefs: [
                { assetId: "asset-anchor", role: "background" },
                { assetId: "asset-b", role: "overlay" },
              ],
            },
            {
              shotId: "sh-002",
              narration: "第二句。",
              visualType: "symbol",
              assetRefs: [{ assetId: "asset-anchor", role: "symbol" }],
            },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
  );
  writeCopyDocV2(join(projectDir, "copy.json"), copy);

  const res = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/assets`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.categories).toEqual([
    "ai-generated",
    "live-action",
    "archive-photo",
    "3d-render",
    "video-clip",
    "style-anchor",
  ]);
  const byLabel = new Map<string, { boundShots: number }>(
    body.items.map((item: { label: string; boundShots: number }) => [item.label, item]),
  );
  expect(byLabel.get("水银档案.jpg")).toMatchObject({ boundShots: 3 });
  expect(byLabel.get("叠加图.png")).toMatchObject({ boundShots: 1 });

  // 分类筛选：archive-photo 只剩锚点资产
  const filtered = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/assets?visualCategory=archive-photo`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(filtered.statusCode).toBe(200);
  const filteredItems = filtered.json().items;
  expect(filteredItems).toHaveLength(1);
  expect(filteredItems[0]).toMatchObject({ label: "水银档案.jpg", boundShots: 3 });

  // 非法分类返回 400 ASSET_INVALID
  const invalid = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/assets?visualCategory=not-a-category`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: { code: "ASSET_INVALID" } });
});

test("POST /api/projects/:id/runs：成功 201、run 落库且非阻塞触发工作流", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa", "2.0");
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

test("POST /api/projects/:id/runs：存量 v1 项目返回 400 且给出可执行迁移提示", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  // 默认契约版本即 1.0（存量项目），legacy 通道已移除，不允许续跑
  const { project } = seedProject(userA, "legacy-run");
  const tokenA = signAccessToken(app, userA);

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/runs`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {},
  });

  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  expect(res.json().error.message).toContain("契约版本为 1.0");
  expect(res.json().error.message).toContain("新建项目");
  // 未创建 run、也未触发工作流（早期拦截，不产生中间产物）
  expect(workflowState.run).not.toHaveBeenCalled();
});

test("POST /api/projects/:id/runs：项目已有活跃 run 返回 409 PROJECT_BUSY", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("ua");
  const { actor, project, session } = seedProject(userA, "pa", "2.0");
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
  // 断点判据在 v2 下要求 copy/cues 结构合法，故本项目用 v2 契约
  const { actor, project, session } = seedProject(userA, "proj-reconcile", "2.0");
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
  // 用共享夹具写出结构合法的 v2 产物（copy + cues），使 tts 阶段判据通过
  const copy = writeFixtureCopyV2(projectDir);
  writeFixtureCues(projectDir, copy);

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
