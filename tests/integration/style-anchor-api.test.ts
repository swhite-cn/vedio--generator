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
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import {
  createProjectAsset,
  getProjectAsset,
} from "../../apps/server/src/db/repositories/asset-repository";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";
import { createEventBus } from "../../apps/server/src/http/event-bus";
import { registerHttpRoutes } from "../../apps/server/src/http/index";
import type { ChatPort, HttpDeps } from "../../apps/server/src/http/deps";
import type { WorkflowEngine } from "../../apps/server/src/workflow/engine";
import { loadSystemConfig } from "../../packages/pipeline/src/config";
import { parseCopyV2Json, readCopyDocument, writeCopyDocV2 } from "../../packages/pipeline/src/index";

/**
 * 风格锚运营路由（T401）的 HTTP 集成测试。
 * 用真实 SQLite 临时库 + 真实 Fastify 应用覆盖：
 * 绑定图片资产、seed 编辑、解绑、显式重建归档、非图片/未知锚点/越权反例与资产 metadata 留痕。
 */

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const TEST_SECRET = "a".repeat(32);
const PASSWORD = "password123";

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

/** 为指定用户建一个项目与会话。 */
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

/**
 * 在项目目录写入 v2 copy：mercury 锚点被 sh-001 引用，gold 无引用。
 * @param projectDir 项目绝对目录
 */
function seedCopy(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true });
  const copy = parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [
        { key: "mercury", label: "水银", color: "#C9CED6" },
        { key: "gold", label: "黄金", color: "#E4B95B" },
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
              anchorKeys: ["mercury"],
            },
            { shotId: "sh-002", narration: "第二句。", visualType: "image" },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
  );
  writeCopyDocV2(join(projectDir, "copy.json"), copy);
}

beforeEach(async () => {
  workflowState.run.mockClear();
  directory = await mkdtemp(join(tmpdir(), "videoforge-style-anchor-api-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

test("PATCH 绑定图片资产：写回 copy、回填 metadata 与绑定镜头", async () => {
  const { app, deps } = await buildTestApp();
  const user = seedUser("uanchor");
  const { actor, project } = seedProject(user, "anchor");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopy(projectDir);

  const asset = createProjectAsset(deps.db, actor, {
    projectId: project.id,
    source: "uploaded",
    kind: "image",
    label: "水银锚.png",
    relativePath: "assets/uploads/a-1/水银锚.png",
    mimeType: "image/png",
    sizeBytes: 128,
  });

  const res = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/mercury`,
    headers: { authorization: `Bearer ${token}` },
    payload: { assetId: asset.id, seed: 4242 },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    anchor: { key: "mercury", assetId: asset.id, assetPath: "assets/uploads/a-1/水银锚.png", seed: 4242 },
    boundShotIds: ["sh-001"],
  });

  const document = readCopyDocument(join(projectDir, "copy.json"));
  expect(document.version).toBe("2");
  const anchor = document.doc.styleAnchors.find((item) => item.key === "mercury");
  expect(anchor).toMatchObject({ assetId: asset.id, seed: 4242 });

  const stored = getProjectAsset(deps.db, actor, asset.id);
  expect(stored?.metadata_json).toMatchObject({
    styleAnchorKey: "mercury",
    generationSeed: 4242,
    boundShotIds: ["sh-001"],
  });
});

test("PATCH 解绑与非法输入：assetId=null 清空，非图片/未知锚点/负 seed 拒绝", async () => {
  const { app, deps } = await buildTestApp();
  const user = seedUser("uanchor2");
  const { actor, project } = seedProject(user, "anchor2");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopy(projectDir);

  const unbound = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/mercury`,
    headers: { authorization: `Bearer ${token}` },
    payload: { assetId: null },
  });
  expect(unbound.statusCode).toBe(200);
  expect(unbound.json().anchor.assetId).toBeUndefined();

  const audio = createProjectAsset(deps.db, actor, {
    projectId: project.id,
    source: "uploaded",
    kind: "audio",
    label: "bgm.mp3",
    relativePath: "assets/uploads/a-2/bgm.mp3",
    mimeType: "audio/mpeg",
    sizeBytes: 64,
  });
  const nonImage = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/gold`,
    headers: { authorization: `Bearer ${token}` },
    payload: { assetId: audio.id },
  });
  expect(nonImage.statusCode).toBe(400);
  expect(nonImage.json()).toMatchObject({ error: { code: "ASSET_INVALID" } });

  const unknown = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/missing`,
    headers: { authorization: `Bearer ${token}` },
    payload: { seed: 1 },
  });
  expect(unknown.statusCode).toBe(400);

  const badSeed = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/mercury`,
    headers: { authorization: `Bearer ${token}` },
    payload: { seed: -5 },
  });
  expect(badSeed.statusCode).toBe(400);
  expect(badSeed.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
});

test("POST 重建：归档缓存图、清空绑定并返回 nextStage=image", async () => {
  const { app, deps } = await buildTestApp();
  const user = seedUser("uanchor3");
  const { actor, project } = seedProject(user, "anchor3");
  const token = signAccessToken(app, user);
  const projectDir = resolveUserProjectDir(directory, user.id, project.name);
  seedCopy(projectDir);
  mkdirSync(join(projectDir, "images", "anchors"), { recursive: true });
  writeFileSync(join(projectDir, "images", "anchors", "mercury.png"), "fake-png");

  const asset = createProjectAsset(deps.db, actor, {
    projectId: project.id,
    source: "uploaded",
    kind: "image",
    label: "锚.png",
    relativePath: "assets/uploads/a-3/锚.png",
    mimeType: "image/png",
    sizeBytes: 128,
  });
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/mercury`,
    headers: { authorization: `Bearer ${token}` },
    payload: { assetId: asset.id },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/style-anchors/mercury/rebuild`,
    headers: { authorization: `Bearer ${token}` },
    payload: { seed: 99 },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    anchor: { key: "mercury", seed: 99 },
    archived: true,
    nextStage: "image",
  });
  expect(res.json().anchor.assetId).toBeUndefined();
  expect(existsSync(join(projectDir, "images", "anchors", "mercury.png"))).toBe(false);
  expect(existsSync(join(projectDir, "images", "history"))).toBe(true);

  const document = readCopyDocument(join(projectDir, "copy.json"));
  expect(document.doc.styleAnchors.find((item) => item.key === "mercury")?.assetId).toBeUndefined();
});

test("跨用户访问风格锚路由返回 403", async () => {
  const { app } = await buildTestApp();
  const userA = seedUser("uanchorA");
  const userB = seedUser("uanchorB");
  const { project } = seedProject(userA, "anchorA");
  const projectDir = resolveUserProjectDir(directory, userA.id, project.name);
  seedCopy(projectDir);
  const tokenB = signAccessToken(app, userB);

  const res = await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.id}/style-anchors/mercury`,
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { seed: 1 },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
});
