import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Actor } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { createRun } from "../../apps/server/src/db/repositories/run-repository";
import { listRunStages } from "../../apps/server/src/db/repositories/run-stage-repository";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";
import { createTraceStore } from "../../apps/server/src/trace/trace-store";

/** 测试用敏感值（放进 ARK_API_KEY，脱敏器应替换为 ***）。 */
const SECRET = "ark-super-secret-key-123";
const PROJECT_NAME = "trace-project";

let directory: string;
let database: ReturnType<typeof createDatabase>;
let projectId: string;
let sessionId: string;
let runId: string;
let traceFile: string;

const userA: Actor = { userId: "user-a", role: "user" };
const userB: Actor = { userId: "user-b", role: "user" };

/** 读取项目目录下的 trace.jsonl 行（不存在时返回空数组）。 */
function readTraceLines(): any[] {
  if (!existsSync(traceFile)) return [];
  return readFileSync(traceFile, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  process.env.ARK_API_KEY = SECRET;
  directory = await mkdtemp(join(tmpdir(), "videoforge-trace-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: PROJECT_NAME,
    topic: "黑洞",
    profile: "landscape-1080p",
  });
  projectId = project.id;
  const session = createSession(database.db, userA, { projectId, title: "会话" });
  sessionId = session.id;
  const run = createRun(database.db, userA, { projectId, sessionId, trigger: "user" });
  runId = run.id;
  traceFile = join(resolveUserProjectDir(directory, userA.userId, PROJECT_NAME), "trace.jsonl");
});

afterEach(async () => {
  delete process.env.ARK_API_KEY;
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

describe("trace store", () => {
  test("recordToolCall 先脱敏再落盘并双写 trace.jsonl", () => {
    const store = createTraceStore({
      db: database.db,
      actor: userA,
      storageRoot: directory,
      rootDir: directory,
    });
    const record = store.recordToolCall({
      sessionId,
      runId,
      tool: "bash",
      args: { command: `echo ${SECRET}` },
      ok: true,
      durationMs: 12,
    });
    expect(JSON.stringify(record.args_json)).not.toContain(SECRET);
    expect(JSON.stringify(record.args_json)).toContain("***");

    const lines = readTraceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "tool_call", tool: "bash", run_id: runId });
    expect(readFileSync(traceFile, "utf-8")).not.toContain(SECRET);
  });

  test("自由对话（无 runId/stageId）仅挂 sessionId，不报错", () => {
    const store = createTraceStore({
      db: database.db,
      actor: userA,
      storageRoot: directory,
      rootDir: directory,
    });
    const record = store.recordToolCall({
      sessionId,
      tool: "read",
      args: {},
      ok: true,
      durationMs: 1,
    });
    expect(record.run_id).toBeUndefined();
    expect(record.stage_id).toBeUndefined();
    const line = readTraceLines()[0];
    expect(line.run_id).toBeNull();
    expect(line.stage_id).toBeNull();
  });

  test("recordLlmCall 对 request/response 全文脱敏", () => {
    const store = createTraceStore({
      db: database.db,
      actor: userA,
      storageRoot: directory,
      rootDir: directory,
    });
    const record = store.recordLlmCall({
      sessionId,
      runId,
      model: "ark-model",
      request: { messages: [{ role: "user", content: `key=${SECRET}` }] },
      response: { content: `echo ${SECRET}` },
      promptTokens: 10,
      completionTokens: 5,
      durationMs: 100,
      ok: true,
    });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    const raw = readFileSync(traceFile, "utf-8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("***");
    expect(readTraceLines()[0]).toMatchObject({ type: "llm_call", model: "ark-model" });
  });

  test("recordStage 先创建后更新并双写 trace.jsonl", () => {
    const store = createTraceStore({
      db: database.db,
      actor: userA,
      storageRoot: directory,
      rootDir: directory,
    });
    const first = store.recordStage({
      runId,
      stage: "copy",
      status: "running",
      attempt: 0,
      startedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(first.status).toBe("running");
    store.recordStage({
      runId,
      stage: "copy",
      status: "done",
      attempt: 0,
      endedAt: "2026-10-25T00:01:00.000Z",
      artifactPaths: ["copy.json"],
    });

    const stages = listRunStages(database.db, userA, runId);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe("done");
    expect(stages[0].artifact_paths).toEqual(["copy.json"]);
    expect(stages[0].ended_at).toBe("2026-10-25T00:01:00.000Z");

    const lines = readTraceLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ type: "run_stage", status: "done" });
  });

  test("recordStage 追加写入不同 attempt 的新行", () => {
    const store = createTraceStore({
      db: database.db,
      actor: userA,
      storageRoot: directory,
      rootDir: directory,
    });
    store.recordStage({
      runId,
      stage: "copy",
      status: "failed",
      attempt: 0,
      errorCode: "ADAPTER_FAILED",
    });
    store.recordStage({ runId, stage: "copy", status: "done", attempt: 1 });
    expect(listRunStages(database.db, userA, runId)).toHaveLength(2);
    expect(readTraceLines()).toHaveLength(2);
  });

  test("actor 不属于会话时抛 AUTH_FORBIDDEN 且不落 trace.jsonl", () => {
    const storeB = createTraceStore({
      db: database.db,
      actor: userB,
      storageRoot: directory,
      rootDir: directory,
    });
    expect(() =>
      storeB.recordToolCall({ sessionId, tool: "bash", args: {}, ok: true, durationMs: 1 }),
    ).toThrow("AUTH_FORBIDDEN");
    expect(existsSync(resolveUserProjectDir(directory, userB.userId, PROJECT_NAME))).toBe(false);
  });
});
