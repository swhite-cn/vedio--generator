import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import {
  adminListRuns,
  createRun,
  findActiveRun,
  getRun,
  listRuns,
  updateRunStatus,
} from "../../apps/server/src/db/repositories/run-repository";

let directory: string;
let database: ReturnType<typeof createDatabase>;
let projectId: string;
let sessionId: string;

const userA: Actor = { userId: "user-a", role: "user" };
const userB: Actor = { userId: "user-b", role: "user" };
const admin: Actor = { userId: "admin-1", role: "admin" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-runs-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: "run-project",
    topic: "黑洞",
    profile: "landscape-1080p",
  });
  projectId = project.id;
  const session = createSession(database.db, userA, { projectId, title: "会话" });
  sessionId = session.id;
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

describe("run 仓储", () => {
  test("创建 run 默认 queued 且归属正确", () => {
    const run = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
    expect(run.status).toBe("queued");
    expect(run.trigger).toBe("user");
    expect(run.current_stage).toBeNull();
    expect(run.error_code).toBeNull();
  });

  test("run 按 user_id 隔离：他人不可见", () => {
    const run = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
    expect(getRun(database.db, userA, run.id)?.id).toBe(run.id);
    expect(getRun(database.db, userB, run.id)).toBeUndefined();
    expect(listRuns(database.db, userB, projectId)).toHaveLength(0);
  });

  test("不能为他人的项目创建 run", () => {
    expect(() => createRun(database.db, userB, { projectId, sessionId, trigger: "user" })).toThrow(
      "AUTH_FORBIDDEN",
    );
  });

  test("活跃 run 判定与释放（租约）", () => {
    const run = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
    expect(findActiveRun(database.db, userA, projectId)?.id).toBe(run.id);
    updateRunStatus(database.db, userA, run.id, { status: "done" });
    expect(findActiveRun(database.db, userA, projectId)).toBeUndefined();
  });

  test("updateRunStatus 写入错误码、阶段与时间戳，且仅限本人", () => {
    const run = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
    updateRunStatus(database.db, userA, run.id, {
      status: "failed",
      errorCode: "ADAPTER_FAILED",
      currentStage: "tts",
      startedAt: "2026-10-25T00:00:00.000Z",
      endedAt: "2026-10-25T00:01:00.000Z",
    });
    const updated = getRun(database.db, userA, run.id);
    expect(updated).toMatchObject({
      status: "failed",
      error_code: "ADAPTER_FAILED",
      current_stage: "tts",
      started_at: "2026-10-25T00:00:00.000Z",
      ended_at: "2026-10-25T00:01:00.000Z",
    });
    expect(() => updateRunStatus(database.db, userB, run.id, { status: "done" })).toThrow(
      "AUTH_FORBIDDEN",
    );
  });

  test("adminListRuns 跨用户只读、支持过滤且仅 admin 可用", () => {
    const ok = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
    updateRunStatus(database.db, userA, ok.id, { status: "done" });
    const failed = createRun(database.db, userA, { projectId, sessionId, trigger: "retry" });
    updateRunStatus(database.db, userA, failed.id, {
      status: "failed",
      errorCode: "TOOL_UNAVAILABLE",
    });

    expect(adminListRuns(database.db, admin)).toHaveLength(2);
    expect(adminListRuns(database.db, admin, { status: "failed" }).map((r) => r.id)).toEqual([
      failed.id,
    ]);
    expect(
      adminListRuns(database.db, admin, { errorCode: "TOOL_UNAVAILABLE" }).map((r) => r.id),
    ).toEqual([failed.id]);
    expect(() => adminListRuns(database.db, userA)).toThrow("AUTH_FORBIDDEN");
  });
});
