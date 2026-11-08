import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { syncGeneratedProjectAssets } from "../../apps/server/src/domain/project-assets";
import {
  createMessageAssetRefs,
  createProjectAsset,
  getProjectAsset,
  listMessageAssetRefs,
  listProjectAssets,
} from "../../apps/server/src/db/repositories/asset-repository";
import { appendMessage } from "../../apps/server/src/db/repositories/message-repository";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";

let directory: string;
let database: ReturnType<typeof createDatabase>;
const actorA: Actor = { userId: "asset-user-a", role: "user" };
const actorB: Actor = { userId: "asset-user-b", role: "user" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-assets-"));
  migrateDatabase(join(directory, "videoforge.db"));
  database = createDatabase(join(directory, "videoforge.db"));
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

/** 为指定 actor 创建项目、会话和一条用户消息。 */
function seed(actor: Actor, name: string) {
  const project = createProject(database.db, actor, {
    capabilityId: "video-generation",
    name,
    topic: "资产测试",
    profile: "landscape-1080p",
  });
  const session = createSession(database.db, actor, { projectId: project.id, title: "会话" });
  const message = appendMessage(database.db, actor, {
    sessionId: session.id,
    role: "user",
    payload: { role: "user", content: "分析引用资产" },
  });
  return { project, message };
}

describe("项目资产仓储", () => {
  test("仅当前项目所属用户可读取并引用资产", () => {
    const a = seed(actorA, "asset-project-a");
    const b = seed(actorB, "asset-project-b");
    const asset = createProjectAsset(database.db, actorA, {
      projectId: a.project.id,
      source: "uploaded",
      kind: "image",
      label: "参考图.png",
      relativePath: "assets/uploads/a/参考图.png",
      mimeType: "image/png",
      sizeBytes: 128,
    });

    expect(listProjectAssets(database.db, actorA, a.project.id)).toHaveLength(1);
    expect(listProjectAssets(database.db, actorB, a.project.id)).toEqual([]);
    expect(getProjectAsset(database.db, actorB, asset.id)).toBeUndefined();
    expect(() => createMessageAssetRefs(database.db, actorB, b.message.id, [asset.id])).toThrow(
      /AUTH_FORBIDDEN/,
    );
  });

  test("素材库分类可写入并按分类筛选", () => {
    const a = seed(actorA, "asset-project-category");
    const asset = createProjectAsset(database.db, actorA, {
      projectId: a.project.id,
      source: "uploaded",
      kind: "image",
      visualCategory: "archive-photo",
      label: "档案照片.jpg",
      relativePath: "assets/uploads/a/档案照片.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 256,
    });
    expect(asset.visual_category).toBe("archive-photo");
    expect(
      listProjectAssets(database.db, actorA, a.project.id, { visualCategory: "archive-photo" }),
    ).toHaveLength(1);
    expect(
      listProjectAssets(database.db, actorA, a.project.id, { visualCategory: "ai-generated" }),
    ).toEqual([]);
  });

  test("同一资产只在消息中保存一条引用且保留顺序", () => {
    const a = seed(actorA, "asset-project-order");
    const first = createProjectAsset(database.db, actorA, {
      projectId: a.project.id,
      source: "uploaded",
      kind: "document",
      label: "说明.md",
      relativePath: "assets/uploads/a/说明.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
    });
    const second = createProjectAsset(database.db, actorA, {
      projectId: a.project.id,
      source: "uploaded",
      kind: "audio",
      label: "背景.mp3",
      relativePath: "assets/uploads/b/背景.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 18,
    });

    createMessageAssetRefs(database.db, actorA, a.message.id, [second.id, first.id, second.id]);
    expect(listMessageAssetRefs(database.db, actorA, [a.message.id]).get(a.message.id)).toEqual([
      expect.objectContaining({ asset_id: second.id, ordinal: 0 }),
      expect.objectContaining({ asset_id: first.id, ordinal: 1 }),
    ]);
  });

  test("流水线图片、场景和音频会幂等登记为生成资产", () => {
    const a = seed(actorA, "generated-assets-project");
    const index = {
      finalVideoExists: false,
      entries: [
        {
          stage: "image" as const,
          label: "配图生成",
          relativePath: "images/s1.png",
          sizeBytes: 11,
        },
        {
          stage: "scene" as const,
          label: "场景生成",
          relativePath: "scenes/s1.html",
          sizeBytes: 22,
        },
        { stage: "tts" as const, label: "语音合成", relativePath: "audio/s1.mp3", sizeBytes: 33 },
      ],
    };

    expect(syncGeneratedProjectAssets(database.db, actorA, a.project, index)).toHaveLength(3);
    expect(syncGeneratedProjectAssets(database.db, actorA, a.project, index)).toHaveLength(0);
    expect(listProjectAssets(database.db, actorA, a.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "generated",
          kind: "image",
          relative_path: "images/s1.png",
        }),
        expect.objectContaining({
          source: "generated",
          kind: "scene",
          relative_path: "scenes/s1.html",
        }),
        expect.objectContaining({
          source: "generated",
          kind: "audio",
          relative_path: "audio/s1.mp3",
        }),
      ]),
    );
  });
});
