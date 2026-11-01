import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import {
  adminListProjects,
  createProject,
  getProject,
  listProjects,
  updateProjectStatus,
} from "../../apps/server/src/db/repositories/project-repository";

let directory: string;
let database: ReturnType<typeof createDatabase>;

const userA: Actor = { userId: "user-a", role: "user" };
const userB: Actor = { userId: "user-b", role: "user" };
const admin: Actor = { userId: "admin-1", role: "admin" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-projects-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

/** 创建测试项目的便捷封装。 */
function makeProject(actor: Actor, name: string) {
  return createProject(database.db, actor, {
    capabilityId: "video-generation",
    name,
    topic: "黑洞是什么",
    profile: "landscape-1080p",
  });
}

describe("项目仓储", () => {
  test("允许中文与空格的项目名", () => {
    const project = makeProject(userA, "我的 第一个项目");
    expect(project.name).toBe("我的 第一个项目");
    expect(project.user_id).toBe("user-a");
    expect(project.status).toBe("draft");
  });

  test("同名冲突在用户范围内追加 -2、-3", () => {
    expect(makeProject(userA, "demo").name).toBe("demo");
    expect(makeProject(userA, "demo").name).toBe("demo-2");
    expect(makeProject(userA, "demo").name).toBe("demo-3");
    // 不同用户互不影响
    expect(makeProject(userB, "demo").name).toBe("demo");
  });

  test("非法项目名抛 PATH_OUTSIDE_STORAGE", () => {
    expect(() => makeProject(userA, "a/b")).toThrow("PATH_OUTSIDE_STORAGE");
    expect(() => makeProject(userA, "../escape")).toThrow("PATH_OUTSIDE_STORAGE");
  });

  test("项目按 user_id 隔离：他人不可见", () => {
    const project = makeProject(userA, "私有项目");
    expect(getProject(database.db, userA, project.id)?.id).toBe(project.id);
    expect(getProject(database.db, userB, project.id)).toBeUndefined();
    expect(listProjects(database.db, userB)).toHaveLength(0);
    expect(listProjects(database.db, userA)).toHaveLength(1);
  });

  test("updateProjectStatus 只作用于本人项目", () => {
    const project = makeProject(userA, "状态项目");
    updateProjectStatus(database.db, userA, project.id, "running");
    expect(getProject(database.db, userA, project.id)?.status).toBe("running");
    expect(() => updateProjectStatus(database.db, userB, project.id, "done")).toThrow(
      "AUTH_FORBIDDEN",
    );
  });

  test("adminListProjects 跨用户只读且仅 admin 可用", () => {
    makeProject(userA, "p1");
    makeProject(userB, "p2");
    expect(adminListProjects(database.db, admin)).toHaveLength(2);
    expect(() => adminListProjects(database.db, userA)).toThrow("AUTH_FORBIDDEN");
  });
});
