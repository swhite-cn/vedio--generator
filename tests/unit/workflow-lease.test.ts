import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  RUN_ERROR_INTERRUPTED,
  VideoForgeError,
  type Actor,
  type RunStatus,
} from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createRun, getRun } from "../../apps/server/src/db/repositories/run-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { assertProjectLease, recoverInterruptedRuns } from "../../apps/server/src/workflow/lease";

/**
 * 项目租约与启动恢复单测（Phase 8 Step 2）。
 * 使用真实 SQLite 临时库覆盖租约冲突（含 `waiting_review`）与启动恢复语义。
 */

const userA: Actor = { userId: "user-a", role: "user" };

let directory: string;
let database: ReturnType<typeof createDatabase>;
let projectId: string;
let sessionId: string;

/** 为项目创建一条指定状态的 run，返回其 ID。 */
function seedRun(status: RunStatus): string {
  return createRun(database.db, userA, {
    projectId,
    sessionId,
    trigger: "user",
    status,
  }).id;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "videoforge-lease-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);

  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: "lease-project",
    topic: "黑洞",
    profile: "landscape-1080p",
  });
  projectId = project.id;
  sessionId = createSession(database.db, userA, { projectId, title: "会话" }).id;
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("assertProjectLease：租约冲突检查", () => {
  test("无活跃 run → 通过", () => {
    expect(() => assertProjectLease(database.db, userA, projectId)).not.toThrow();
  });

  test.each<RunStatus>(["queued", "running", "waiting_review"])(
    "存在活跃 run（%s）→ 抛 PROJECT_BUSY",
    (status) => {
      seedRun(status);
      const error = (() => {
        try {
          assertProjectLease(database.db, userA, projectId);
          return undefined;
        } catch (err) {
          return err;
        }
      })();
      expect(error).toBeInstanceOf(VideoForgeError);
      expect((error as VideoForgeError).code).toBe("PROJECT_BUSY");
    },
  );

  test.each<RunStatus>(["done", "failed", "canceled"])(
    "终态/非活跃 run（%s）→ 不阻塞",
    (status) => {
      seedRun(status);
      expect(() => assertProjectLease(database.db, userA, projectId)).not.toThrow();
    },
  );

  test("其他 actor 的项目不可见（归属校验，不误报忙碌）", () => {
    seedRun("running");
    const userB: Actor = { userId: "user-b", role: "user" };
    expect(() => assertProjectLease(database.db, userB, projectId)).not.toThrow();
  });
});

describe("recoverInterruptedRuns：启动恢复", () => {
  test("running + 残留 queued 置 canceled/INTERRUPTED，waiting_review 与终态不动", () => {
    const runningId = seedRun("running");
    const queuedId = seedRun("queued");
    const waitingId = seedRun("waiting_review");
    const doneId = seedRun("done");
    const failedId = seedRun("failed");
    const canceledId = seedRun("canceled");

    const count = recoverInterruptedRuns(database.db);
    expect(count).toBe(2);

    const running = getRun(database.db, userA, runningId)!;
    expect(running.status).toBe("canceled");
    expect(running.error_code).toBe(RUN_ERROR_INTERRUPTED);
    expect(running.ended_at).not.toBeNull();

    const queued = getRun(database.db, userA, queuedId)!;
    expect(queued.status).toBe("canceled");
    expect(queued.error_code).toBe(RUN_ERROR_INTERRUPTED);

    expect(getRun(database.db, userA, waitingId)!.status).toBe("waiting_review");
    expect(getRun(database.db, userA, doneId)!.status).toBe("done");
    expect(getRun(database.db, userA, failedId)!.status).toBe("failed");
    expect(getRun(database.db, userA, canceledId)!.status).toBe("canceled");
  });

  test("无待恢复 run → 返回 0", () => {
    seedRun("waiting_review");
    seedRun("done");
    expect(recoverInterruptedRuns(database.db)).toBe(0);
  });

  test("恢复后项目租约解除（可再次发起 run）", () => {
    seedRun("running");
    expect(() => assertProjectLease(database.db, userA, projectId)).toThrow();

    recoverInterruptedRuns(database.db);

    expect(() => assertProjectLease(database.db, userA, projectId)).not.toThrow();
  });
});
