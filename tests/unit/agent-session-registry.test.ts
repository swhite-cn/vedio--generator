import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SystemConfig } from "@videoforge/pipeline";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import {
  SESSION_IDLE_TIMEOUT_MS,
  createSessionRegistry,
  type AgentSdkPort,
} from "../../apps/server/src/agent/session-registry";
import type { TraceStore } from "../../apps/server/src/trace/trace-store";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { appendMessage } from "../../apps/server/src/db/repositories/message-repository";
import { createProject } from "../../apps/server/src/db/repositories/project-repository";
import { createSession } from "../../apps/server/src/db/repositories/session-repository";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";

// 会话注册表会在组装期构造阶段工具/内置工具。只 stub 会发真实网络/子进程的生成函数，
// 保留 `validateProjectName` / `assertInsideUserRoot` 等路径安全函数的真实实现（建项目/建目录要用）。
vi.mock("@videoforge/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@videoforge/pipeline")>();
  return {
    ...actual,
    generateCopy: vi.fn(),
    generateImages: vi.fn(),
    generateScenes: vi.fn(),
    generateSpeech: vi.fn(),
    generateStoryboard: vi.fn(),
    composeVideoStep: vi.fn(),
  };
});
vi.mock("@videoforge/renderer", () => ({ renderFrames: vi.fn() }));

/**
 * 会话注册表单测（Phase 7 Step 3）。
 * 用「假 SDK 端口 + 真实 SQLite（临时目录）」覆盖创建/复用/历史重放/越权/回收/工具装配，
 * 全程不加载真实 Pi SDK，不读开发机的 gitignored 配置。
 */

const PROJECT_NAME = "registry-project";

const userA: Actor = { userId: "user-a", role: "user" };
const userB: Actor = { userId: "user-b", role: "user" };

let directory: string;
let rootDir: string;
let database: ReturnType<typeof createDatabase>;
let projectId: string;
let sessionId: string;
let config: SystemConfig;
/** 可控时钟（毫秒），供空闲回收测试推进。 */
let clock: number;

/** 构造最小配置（注册表只用 runtime.max_concurrent_stage 与 agent.allow_shell_write_edit）。 */
function makeConfig(allowShellWriteEdit: boolean): SystemConfig {
  return {
    runtime: { max_concurrent_stage: 1 },
    agent: { allow_shell_write_edit: allowShellWriteEdit },
  } as unknown as SystemConfig;
}

/** 假 AgentSession：只实现被测代码用到的 dispose / subscribe。 */
interface FakeSession {
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  /** 测试辅助：向全部订阅者投递一条事件。 */
  emit: (event: unknown) => void;
}

/** 创建假会话（dispose / subscribe 均为可断言的 spy，并支持手动投递事件）。 */
function createFakeSession(): FakeSession {
  const listeners = new Set<(event: unknown) => void>();
  return {
    dispose: vi.fn(),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
}

/** 假 SDK 端口：记录 createAgentSession 的 options、以及每个内存管理器上的 appendMessage 调用。 */
function createFakePort() {
  const sessions: FakeSession[] = [];
  const managers: Array<{ appendMessage: ReturnType<typeof vi.fn> }> = [];

  const createAgentSession = vi.fn(async (_options: CreateAgentSessionOptions) => {
    const session = createFakeSession();
    sessions.push(session);
    return { session: session as unknown as AgentSession };
  });

  const createInMemorySessionManager = vi.fn((_cwd: string) => {
    const appendMessageMock = vi.fn();
    managers.push({ appendMessage: appendMessageMock });
    return { appendMessage: appendMessageMock } as unknown as SessionManager;
  });

  const port: AgentSdkPort = { createAgentSession, createInMemorySessionManager };
  return { port, createAgentSession, createInMemorySessionManager, sessions, managers };
}

/** 用假端口 + 可控时钟构造注册表。 */
function makeRegistry(
  port: AgentSdkPort,
  overrides: {
    idleTimeoutMs?: number;
    config?: SystemConfig;
    trace?: TraceStore;
    onSessionEvent?: (sessionId: string, event: any) => void;
  } = {},
) {
  return createSessionRegistry({
    rootDir,
    storageRoot: directory,
    db: database.db,
    config: overrides.config ?? config,
    modelRuntime: {} as any,
    model: {} as any,
    port,
    trace: overrides.trace,
    onSessionEvent: overrides.onSessionEvent,
    idleTimeoutMs: overrides.idleTimeoutMs,
    now: () => clock,
  });
}

beforeEach(() => {
  clock = 0;
  directory = mkdtempSync(join(tmpdir(), "videoforge-registry-"));
  rootDir = mkdtempSync(join(tmpdir(), "videoforge-registry-root-"));
  // resolveOutputProfile 会读 <rootDir>/config/profiles/，夹具里放一个空的 landscape-1080p.yaml
  mkdirSync(join(rootDir, "config", "profiles"), { recursive: true });
  writeFileSync(join(rootDir, "config", "profiles", "landscape-1080p.yaml"), "");

  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);

  config = makeConfig(true);
  const project = createProject(database.db, userA, {
    capabilityId: "video-generation",
    name: PROJECT_NAME,
    topic: "黑洞",
    profile: "landscape-1080p",
  });
  projectId = project.id;
  sessionId = createSession(database.db, userA, { projectId, title: "会话" }).id;
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

describe("createSessionRegistry：会话创建与上下文装配", () => {
  test("首次创建：注入 projectDir、noTools=builtin，并写表", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);

    const entry = await registry.getOrCreate(userA, sessionId);

    expect(entry.sessionId).toBe(sessionId);
    expect(entry.projectId).toBe(projectId);
    expect(entry.userId).toBe(userA.userId);
    expect(entry.projectDir).toBe(resolveUserProjectDir(directory, userA.userId, PROJECT_NAME));

    expect(fake.createAgentSession).toHaveBeenCalledTimes(1);
    const options = fake.createAgentSession.mock.calls[0][0];
    expect(options.cwd).toBe(entry.projectDir);
    expect(options.noTools).toBe("builtin");
    expect(registry.size).toBe(1);
  });

  test("复用：第二次返回同一 session 引用，createAgentSession 只调一次，lastActiveAt 前进", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);

    const first = await registry.getOrCreate(userA, sessionId);
    const before = first.lastActiveAt;
    clock += 5000;
    const second = await registry.getOrCreate(userA, sessionId);

    expect(second.session).toBe(first.session);
    expect(second.session).toBe(fake.sessions[0] as unknown as AgentSession);
    expect(fake.createAgentSession).toHaveBeenCalledTimes(1);
    expect(second.lastActiveAt).toBeGreaterThan(before);
  });

  test("customTools：7 阶段工具 + 4 只读内置工具，放开时含 bash/write/edit", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);
    await registry.getOrCreate(userA, sessionId);

    const names = (fake.createAgentSession.mock.calls[0][0].customTools ?? []).map(
      (tool) => tool.name,
    );
    for (const name of [
      "copy_generate",
      "image_generate",
      "scene_generate",
      "tts_generate",
      "storyboard_generate",
      "render_frames",
      "compose_video",
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "write",
      "edit",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("setStageTrace：更新会话的阶段留痕上下文，会话不存在时静默", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);
    const entry = await registry.getOrCreate(userA, sessionId);
    // 新会话默认不带 run / 阶段
    expect(entry.stageTrace).toEqual({ runId: null, stageId: null });

    registry.setStageTrace(sessionId, { runId: "run-1", stageId: "stage-row-1" });
    expect(entry.stageTrace).toEqual({ runId: "run-1", stageId: "stage-row-1" });

    // 只清 run 时 stage 保持不变（Partial 语义）
    registry.setStageTrace(sessionId, { runId: null });
    expect(entry.stageTrace).toEqual({ runId: null, stageId: "stage-row-1" });

    expect(() => registry.setStageTrace("missing-session", { runId: "x" })).not.toThrow();
  });

  test("onSessionEvent：创建时订阅一次并按 sessionId 转发，释放会话时退订", async () => {
    const fake = createFakePort();
    const received: Array<{ sessionId: string; type: string }> = [];
    const registry = makeRegistry(fake.port, {
      onSessionEvent: (sid, event) => received.push({ sessionId: sid, type: String(event?.type) }),
    });

    await registry.getOrCreate(userA, sessionId);
    // 同一个会话被多次取用时不重复订阅（避免事件重复推送）
    await registry.getOrCreate(userA, sessionId);
    const session = fake.sessions[0]!;
    expect(session.subscribe).toHaveBeenCalledTimes(1);

    session.emit({ type: "turn_end" });
    expect(received).toEqual([{ sessionId, type: "turn_end" }]);

    registry.release(sessionId);
    session.emit({ type: "turn_end" });
    expect(received).toHaveLength(1);
  });

  test("resolveLlmTraceTarget：返回会话专属写入器与当前 run / 阶段", async () => {
    const fake = createFakePort();
    const store = {
      recordToolCall: vi.fn(),
      recordLlmCall: vi.fn(),
      recordStage: vi.fn(),
    } as unknown as TraceStore;
    const registry = makeRegistry(fake.port, { trace: store });

    await registry.getOrCreate(userA, sessionId);
    expect(registry.resolveLlmTraceTarget(sessionId)).toEqual({
      trace: store,
      sessionId,
      runId: undefined,
      stageId: undefined,
    });

    registry.setStageTrace(sessionId, { runId: "run-1", stageId: "stage-row-1" });
    expect(registry.resolveLlmTraceTarget(sessionId)).toMatchObject({
      runId: "run-1",
      stageId: "stage-row-1",
    });

    expect(registry.resolveLlmTraceTarget("missing-session")).toBeUndefined();
    expect(registry.resolveLlmTraceTarget(undefined)).toBeUndefined();
  });

  test("customTools：allow_shell_write_edit=false 时不含 bash/write/edit", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port, { config: makeConfig(false) });
    await registry.getOrCreate(userA, sessionId);

    const names = (fake.createAgentSession.mock.calls[0][0].customTools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toContain("read");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
  });
});

describe("createSessionRegistry：历史消息重放", () => {
  test("按时间顺序逐条 appendMessage（入参即 payload）", async () => {
    const firstPayload = { role: "user", content: [{ type: "text", text: "你好" }] };
    const secondPayload = { role: "assistant", content: [{ type: "text", text: "在的" }] };
    appendMessage(database.db, userA, { sessionId, role: "user", payload: firstPayload });
    appendMessage(database.db, userA, { sessionId, role: "assistant", payload: secondPayload });

    const fake = createFakePort();
    const registry = makeRegistry(fake.port);
    await registry.getOrCreate(userA, sessionId);

    const append = fake.managers[0].appendMessage;
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).toEqual(firstPayload);
    expect(append.mock.calls[1][0]).toEqual(secondPayload);
  });

  test("历史消息损坏（payload 非对象）不阻断会话创建，仅重放合法条数", async () => {
    const good = { role: "user", content: [{ type: "text", text: "ok" }] };
    appendMessage(database.db, userA, { sessionId, role: "user", payload: null });
    appendMessage(database.db, userA, { sessionId, role: "user", payload: good });

    const fake = createFakePort();
    const registry = makeRegistry(fake.port);

    await expect(registry.getOrCreate(userA, sessionId)).resolves.toBeDefined();
    const append = fake.managers[0].appendMessage;
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toEqual(good);
  });
});

describe("createSessionRegistry：归属校验", () => {
  test("越权（跨用户）创建：抛 AUTH_FORBIDDEN 且不创建会话", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);

    const error = await registry.getOrCreate(userB, sessionId).catch((err) => err);
    expect(error).toBeInstanceOf(VideoForgeError);
    expect((error as VideoForgeError).code).toBe("AUTH_FORBIDDEN");
    expect(fake.createAgentSession).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  test("内存命中但归属不符：抛 AUTH_FORBIDDEN", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);
    await registry.getOrCreate(userA, sessionId);
    expect(registry.get(sessionId)).toBeDefined();

    const error = await registry.getOrCreate(userB, sessionId).catch((err) => err);
    expect(error).toBeInstanceOf(VideoForgeError);
    expect((error as VideoForgeError).code).toBe("AUTH_FORBIDDEN");
  });
});

describe("createSessionRegistry：释放与空闲回收", () => {
  test("空闲超时常量为 30 分钟", () => {
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test("release：dispose 一次、从表移除、size 归零；不存在时静默返回", async () => {
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);
    await registry.getOrCreate(userA, sessionId);

    registry.release(sessionId);

    expect(registry.get(sessionId)).toBeUndefined();
    expect(fake.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(() => registry.release("missing")).not.toThrow();
  });

  test("disposeIdle：仅回收超时会话", async () => {
    const secondSessionId = createSession(database.db, userA, { projectId, title: "会话2" }).id;
    const fake = createFakePort();
    const registry = makeRegistry(fake.port, { idleTimeoutMs: 100 });

    clock = 0;
    await registry.getOrCreate(userA, sessionId);
    clock = 50;
    await registry.getOrCreate(userA, secondSessionId);
    clock = 120;

    expect(registry.disposeIdle()).toBe(1);
    expect(registry.get(sessionId)).toBeUndefined();
    expect(registry.get(secondSessionId)).toBeDefined();
    expect(fake.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(fake.sessions[1].dispose).not.toHaveBeenCalled();
  });

  test("disposeAll：释放全部并返回数量", async () => {
    const secondSessionId = createSession(database.db, userA, { projectId, title: "会话2" }).id;
    const fake = createFakePort();
    const registry = makeRegistry(fake.port);

    await registry.getOrCreate(userA, sessionId);
    await registry.getOrCreate(userA, secondSessionId);

    expect(registry.disposeAll()).toBe(2);
    expect(registry.size).toBe(0);
    expect(fake.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(fake.sessions[1].dispose).toHaveBeenCalledTimes(1);
  });
});
