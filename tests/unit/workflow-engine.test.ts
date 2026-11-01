import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import type { SystemConfig } from "@videoforge/pipeline";
import { writeCopyDoc, type CopyDoc } from "@videoforge/pipeline";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createRun, getRun } from "../../apps/server/src/db/repositories/run-repository";
import { listRunStages } from "../../apps/server/src/db/repositories/run-stage-repository";
import { listMessages } from "../../apps/server/src/db/repositories/message-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";
import { getCapability } from "../../apps/server/src/workflow/capabilities";
import {
  createWorkflowEngine,
  type StageChangeRecord,
  type StageExecutionRequest,
  type StageExecutor,
  type StageExecutionResult,
  type WorkflowEvent,
} from "../../apps/server/src/workflow/engine";
import { buildStageInstruction } from "../../apps/server/src/workflow/stage-instruction";

/**
 * 工作流引擎主循环与阶段指令单测（Phase 8 P8-B）。
 * 用「真实 SQLite 临时库 + 注入假执行器」覆盖：首跑到审核点、resume 两分支、断点续跑、
 * 重试上限与重试后成功、审核点 retry、非法流转、取消、指令落库、全局并发信号量，
 * 以及 `buildStageInstruction` 的纯函数行为。执行器按 `request.stage` 写产物，不触真实内核。
 */

const userA: Actor = { userId: "user-a", role: "user" };
const PROJECT_NAME = "wf-project";
const PROJECT_NAME_B = "wf-project-b";

let directory: string;
let database: ReturnType<typeof createDatabase>;
let projectId: string;
let sessionId: string;

/** 构造最小配置（引擎只读 runtime.max_concurrent_stage 与 workflow.max_stage_retry）。 */
function makeConfig(
  overrides: { maxConcurrentStage?: number; maxStageRetry?: number } = {},
): SystemConfig {
  return {
    runtime: { max_concurrent_stage: overrides.maxConcurrentStage ?? 4 },
    workflow: { max_stage_retry: overrides.maxStageRetry ?? 0 },
    agent: { allow_shell_write_edit: false },
  } as unknown as SystemConfig;
}

/** 在项目目录内写文件（自动创建父目录）。 */
function writeProjectFile(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
}

/** 合法的 copy.json 文档（通过 copy-contract 校验）。 */
function validCopyDoc(): CopyDoc {
  return {
    topic: "黑洞是什么",
    style: "科普",
    title: "黑洞",
    scenes: [
      {
        sceneId: "s1",
        title: "引言",
        narration: "黑洞是时空中的一个区域。",
        imagePrompt: "深空中的黑洞",
      },
    ],
  };
}

/** 按阶段写出能让产物判据达标的产物（测试夹具允许含阶段知识）。 */
function writeStageArtifact(request: StageExecutionRequest): string[] {
  const dir = request.projectDir;
  switch (request.stage) {
    case "copy":
      writeCopyDoc(join(dir, "copy.json"), validCopyDoc());
      return ["copy.json"];
    case "image":
      writeProjectFile(dir, "images/cover.png", "png");
      return ["images/cover.png"];
    case "scene":
      writeProjectFile(dir, "scenes/s1.html", "<html></html>");
      return ["scenes/s1.html"];
    case "tts":
      writeProjectFile(dir, "audio/s1.mp3", "mp3");
      return ["audio/s1.mp3"];
    case "storyboard":
      writeProjectFile(dir, "timeline.json", JSON.stringify({ scenes: [] }));
      return ["timeline.json"];
    case "render":
      writeProjectFile(dir, `build/render/${request.profile}/frames/f1.jpg`, "jpg");
      return [`build/render/${request.profile}/frames/f1.jpg`];
    case "compose":
      writeProjectFile(dir, "final.mp4", "mp4");
      return ["final.mp4"];
  }
}

/** 假执行器：记录调用序列、统计最大同时在跑数；可按选项改写产物行为。 */
function makeFakeExecutor(
  options: {
    /** 是否写出达标产物（默认 true）；false 时返回 ok 但不写产物。 */
    write?: boolean;
    /** 每次执行前的延迟（毫秒），用于暴露并发信号量是否生效。 */
    delayMs?: number;
    /** 每次执行的可选钩子（可自行写产物）。 */
    onCall?: (request: StageExecutionRequest) => void;
  } = {},
) {
  const calls: StageExecutionRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const executor: StageExecutor = async (request) => {
    calls.push(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      options.onCall?.(request);
      if (options.write === false) {
        return { ok: true };
      }
      const artifactPaths = writeStageArtifact(request);
      return { ok: true, artifactPaths };
    } finally {
      active -= 1;
    }
  };
  return { executor, calls, getMaxActive: () => maxActive };
}

/** 用假执行器构造引擎（含事件与阶段留痕收集）。 */
function makeEngine(
  executor: StageExecutor,
  config: SystemConfig,
  options: { onStageChange?: (record: StageChangeRecord) => void } = {},
) {
  const events: WorkflowEvent[] = [];
  const engine = createWorkflowEngine({
    db: database.db,
    storageRoot: directory,
    config,
    executeStage: executor,
    emit: (event) => events.push(event),
    onStageChange: options.onStageChange,
  });
  return { engine, events };
}

/** 在 beforeEach 已建项目 / 会话上创建一条 queued run。 */
function newRun(): string {
  return createRun(database.db, userA, { projectId, sessionId, trigger: "user" }).id;
}

/** 断言同步调用抛出 RUN_STATE_INVALID。 */
function expectRunStateInvalid(fn: () => unknown): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(VideoForgeError);
  expect((error as VideoForgeError).code).toBe("RUN_STATE_INVALID");
}

/** 断言异步调用以 RUN_STATE_INVALID 拒绝。 */
async function expectRunStateInvalidAsync(fn: () => Promise<unknown>): Promise<void> {
  const error = await fn().then(
    () => undefined,
    (err) => err,
  );
  expect(error).toBeInstanceOf(VideoForgeError);
  expect((error as VideoForgeError).code).toBe("RUN_STATE_INVALID");
}

/** 按 attempt 升序取某阶段的所有阶段行。 */
function stageRows(runId: string, stage: string) {
  return listRunStages(database.db, userA, runId)
    .filter((row) => row.stage === stage)
    .sort((a, b) => a.attempt - b.attempt);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "videoforge-engine-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);

  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: PROJECT_NAME,
    topic: "黑洞是什么",
    profile: "landscape-1080p",
  });
  projectId = project.id;
  sessionId = createSession(database.db, userA, { projectId, title: "会话" }).id;
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("buildStageInstruction：阶段指令正文（纯函数）", () => {
  const copyStage = getCapability("video-generation")!.stages.find(
    (stage) => stage.stage === "copy",
  )!;

  test("由 label 与 tool 拼装，写入 topic 与 profile，style 为空则省略", () => {
    const text = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: null, profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 0,
    });
    expect(text).toContain("文案生成");
    expect(text).toContain("copy_generate");
    expect(text).toContain("topic=黑洞是什么");
    expect(text).toContain("profile=landscape-1080p");
    expect(text).not.toContain("style=");
  });

  test("style 有值时写入 style 片段", () => {
    const text = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: "科普", profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 0,
    });
    expect(text).toContain("style=科普");
  });

  test("attempt>0 追加重试说明，并可带出上一次错误码", () => {
    const text = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: null, profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 2,
      previousErrorCode: "TOOL_UNAVAILABLE",
    });
    expect(text).toContain("第 2 次重试");
    expect(text).toContain("TOOL_UNAVAILABLE");
  });

  test("attempt>0 且无错误码时不出现错误码片段", () => {
    const text = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: null, profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 1,
    });
    expect(text).toContain("第 1 次重试");
    expect(text).not.toContain("错误码");
  });

  test("feedback 非空时追加用户反馈段", () => {
    const text = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: null, profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 0,
      feedback: "文案再口语化一点",
    });
    expect(text).toContain("用户反馈：文案再口语化一点");
  });
});

describe("workflow engine：状态推进与审核点", () => {
  test("queued 首跑停在 copy 审核点，copy done、后续 pending，执行器仅 1 次", async () => {
    const { executor, calls } = makeFakeExecutor();
    const { engine, events } = makeEngine(executor, makeConfig());

    const runId = newRun();
    const result = await engine.run(userA, runId);

    expect(result.status).toBe("waiting_review");
    expect(result.current_stage).toBe("copy");
    expect(stageRows(runId, "copy")[0].status).toBe("done");
    expect(stageRows(runId, "image")[0].status).toBe("pending");
    expect(stageRows(runId, "compose")[0].status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0].stage).toBe("copy");

    const types = events.map((event) => event.type);
    expect(types).toContain("run_started");
    expect(types).toContain("stage_started");
    expect(types).toContain("stage_done");
    expect(types).toContain("review_gate");
  });

  test("resume(approve) 推进到 image 审核点，copy 行不被改写", async () => {
    const { executor, calls } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    await engine.run(userA, runId);
    const result = await engine.resume(userA, runId, "approve");

    expect(result.status).toBe("waiting_review");
    expect(result.current_stage).toBe("image");
    const copyRows = stageRows(runId, "copy");
    expect(copyRows).toHaveLength(1);
    expect(copyRows[0].status).toBe("done");
    expect(copyRows[0].attempt).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].stage).toBe("image");
  });

  test("连续 approve 到终态：七阶段全 done 且 final.mp4 存在 → run done", async () => {
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    await engine.run(userA, runId);
    await engine.resume(userA, runId, "approve");
    const result = await engine.resume(userA, runId, "approve");

    expect(result.status).toBe("done");
    expect(result.ended_at).not.toBeNull();
    const rows = listRunStages(database.db, userA, runId);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.status).toBe("done");
    }
  });
});

describe("workflow engine：断点续跑与重试", () => {
  test("onStageChange：copy 依次上报 running / done，并携带起止时间与产物", async () => {
    const changes: StageChangeRecord[] = [];
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig(), {
      onStageChange: (record) => changes.push(record),
    });

    const runId = newRun();
    await engine.run(userA, runId);

    const copyChanges = changes.filter((item) => item.stage === "copy");
    expect(copyChanges.map((item) => item.status)).toEqual(["running", "done"]);
    expect(copyChanges[0]!.startedAt).toBeTruthy();
    expect(copyChanges[1]!.endedAt).toBeTruthy();
    expect(copyChanges[1]!.artifactPaths).toEqual(["copy.json"]);
    expect(copyChanges.every((item) => item.runId === runId)).toBe(true);
  });

  test("预置 copy.json：新 run 从 image 起，copy 标 skipped，首调即 image", async () => {
    const projectDir = resolveUserProjectDir(directory, userA.userId, PROJECT_NAME);
    writeCopyDoc(join(projectDir, "copy.json"), validCopyDoc());

    const { executor, calls } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    const result = await engine.run(userA, runId);

    expect(stageRows(runId, "copy")[0].status).toBe("skipped");
    expect(calls[0].stage).toBe("image");
    expect(result.status).toBe("waiting_review");
    expect(result.current_stage).toBe("image");
  });

  test("onStageChange：断点前阶段上报 skipped，带回该 run 与 actor", async () => {
    const projectDir = resolveUserProjectDir(directory, userA.userId, PROJECT_NAME);
    writeCopyDoc(join(projectDir, "copy.json"), validCopyDoc());

    const changes: StageChangeRecord[] = [];
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig(), {
      onStageChange: (record) => changes.push(record),
    });

    const runId = newRun();
    await engine.run(userA, runId);

    const copyChange = changes.find((item) => item.stage === "copy");
    expect(copyChange).toMatchObject({
      actor: userA,
      runId,
      stage: "copy",
      status: "skipped",
      attempt: 0,
    });
  });

  test("重试上限：max_stage_retry=2 且始终不写产物 → attempt 0/1/2 三行 failed，run failed", async () => {
    const { executor, calls } = makeFakeExecutor({ write: false });
    const { engine } = makeEngine(executor, makeConfig({ maxStageRetry: 2 }));

    const runId = newRun();
    const result = await engine.run(userA, runId);

    expect(result.status).toBe("failed");
    expect(result.current_stage).toBe("copy");
    const rows = stageRows(runId, "copy");
    expect(rows.map((row) => row.attempt)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
    expect(calls).toHaveLength(3);
  });

  test("重试后成功：前两次不写产物、第三次写 → 阶段 done，run 停在 copy 审核点", async () => {
    let copyCalls = 0;
    const { executor, calls } = makeFakeExecutor({
      write: false,
      onCall: (request) => {
        if (request.stage === "copy") {
          copyCalls += 1;
          if (copyCalls === 3) {
            writeCopyDoc(join(request.projectDir, "copy.json"), validCopyDoc());
          }
        }
      },
    });
    const { engine } = makeEngine(executor, makeConfig({ maxStageRetry: 2 }));

    const runId = newRun();
    const result = await engine.run(userA, runId);

    expect(result.status).toBe("waiting_review");
    const rows = stageRows(runId, "copy");
    expect(rows.map((row) => row.attempt)).toEqual([0, 1, 2]);
    expect(rows[2].status).toBe("done");
    expect(calls.filter((call) => call.stage === "copy")).toHaveLength(3);
  });

  test("审核点 retry：新建 copy attempt=1 行并透传 feedback，再次 done 后回到 waiting_review", async () => {
    const { executor, calls } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    await engine.run(userA, runId);
    const result = await engine.resume(userA, runId, "retry", "文案再口语化一点");

    expect(result.status).toBe("waiting_review");
    expect(result.current_stage).toBe("copy");
    const rows = stageRows(runId, "copy");
    expect(rows.map((row) => row.attempt)).toEqual([0, 1]);
    expect(rows[1].status).toBe("done");

    const retryCall = calls.find((call) => call.stage === "copy" && call.attempt === 1)!;
    expect(retryCall.feedback).toBe("文案再口语化一点");
    expect(retryCall.instruction).toContain("文案再口语化一点");
  });
});

describe("workflow engine：非法流转与取消", () => {
  /** 把 run 跑到 done 终态。 */
  async function runToDone(engine: ReturnType<typeof makeEngine>["engine"]): Promise<string> {
    const runId = newRun();
    await engine.run(userA, runId);
    await engine.resume(userA, runId, "approve");
    await engine.resume(userA, runId, "approve");
    expect(getRun(database.db, userA, runId)!.status).toBe("done");
    return runId;
  }

  test("对 done run 调用 run/resume/cancel 均抛 RUN_STATE_INVALID", async () => {
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());
    const runId = await runToDone(engine);

    await expectRunStateInvalidAsync(() => engine.run(userA, runId));
    await expectRunStateInvalidAsync(() => engine.resume(userA, runId, "approve"));
    expectRunStateInvalid(() => engine.cancel(userA, runId));
  });

  test("cancel：waiting_review → canceled 且写入 ended_at；对 canceled 再 cancel 抛错", async () => {
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    await engine.run(userA, runId);
    expect(getRun(database.db, userA, runId)!.status).toBe("waiting_review");

    const canceled = engine.cancel(userA, runId);
    expect(canceled.status).toBe("canceled");
    expect(canceled.ended_at).not.toBeNull();

    expectRunStateInvalid(() => engine.cancel(userA, runId));
  });
});

describe("workflow engine：指令落库与全局并发", () => {
  test("阶段指令以 role=system 落库，payload 与 buildStageInstruction 正文一致且挂当前 run", async () => {
    const { executor } = makeFakeExecutor();
    const { engine } = makeEngine(executor, makeConfig());

    const runId = newRun();
    await engine.run(userA, runId);

    const messages = listMessages(database.db, userA, sessionId);
    const systemMessages = messages.filter((message) => message.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].run_id).toBe(runId);

    const copyStage = getCapability("video-generation")!.stages.find(
      (stage) => stage.stage === "copy",
    )!;
    const expected = buildStageInstruction({
      stage: copyStage,
      project: { topic: "黑洞是什么", style: null, profile: "landscape-1080p" },
      profile: "landscape-1080p",
      attempt: 0,
      previousErrorCode: null,
      feedback: null,
    });
    const payload = systemMessages[0].payload as {
      role: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(payload.role).toBe("system");
    expect(Array.isArray(payload.content)).toBe(true);
    expect(payload.content[0].text).toBe(expected);
  });

  test("全局并发信号量：max_concurrent_stage=1 下两个 run 并发，最大同时在跑数为 1", async () => {
    const { executor, getMaxActive } = makeFakeExecutor({ delayMs: 20 });
    const { engine } = makeEngine(executor, makeConfig({ maxConcurrentStage: 1 }));

    const projectB = createProject(database.db, userA, {
      capabilityId: "video-generation",
      name: PROJECT_NAME_B,
      topic: "量子纠缠是什么",
      profile: "landscape-1080p",
    });
    const sessionB = createSession(database.db, userA, {
      projectId: projectB.id,
      title: "会话B",
    }).id;
    const runA = newRun();
    const runB = createRun(database.db, userA, {
      projectId: projectB.id,
      sessionId: sessionB,
      trigger: "user",
    }).id;

    await Promise.all([engine.run(userA, runA), engine.run(userA, runB)]);

    expect(getMaxActive()).toBe(1);
  });
});
