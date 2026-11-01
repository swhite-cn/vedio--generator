import {
  createAgentSession as createPiAgentSession,
  SessionManager as PiSessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SystemConfig } from "@videoforge/pipeline";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import { listMessages } from "../db/repositories/message-repository.js";
import { getProject } from "../db/repositories/project-repository.js";
import { getSession } from "../db/repositories/session-repository.js";
import { resolveUserProjectDir } from "../domain/storage-layout.js";
import type { TraceStore } from "../trace/trace-store.js";
import { createAgentResourceLoader, resolveAgentDir } from "./prompt.js";
import { createAgentTools, resolveOutputProfile } from "./tools/index.js";

/**
 * 进程内 agent 会话注册表（见设计文档 §5.1 / §5.2）。
 *
 * 职责：
 * - 常驻内存 `Map<sessionId, AgentSessionEntry>`，避免每次请求都重建会话；
 * - 取到或创建会话时按 `actor` 做归属校验（会话不存在 / 不属于 actor 一律 `AUTH_FORBIDDEN`）；
 * - 项目重启后运行时丢失时，用 `messages` 表已落库的历史消息重放上下文（§5.2「恢复」）；
 * - 空闲超时或显式释放时 `dispose()` 会话，产物文件不随会话销毁。
 *
 * 设计取舍（§5.2 提到的「落 Pi session 文件 + 重启回读」未采用）：
 * SPIKE §3.2 已确认「赋值 `session.agent.state.messages` 不替换持久化上下文」，
 * 因此改走官方推荐的 `SessionManager.inMemory(cwd)` + 逐条 `appendMessage()` 重放，
 * 数据库是唯一历史来源，无需另外落 Pi session 文件。
 */

/** 会话空闲超时（30 分钟，代码常量，不进配置）。 */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * SDK 端口：生产实现直接用 Pi SDK；单元测试注入假实现。
 *
 * 之所以抽象成端口：`tests/` 目录在 pnpm 严格隔离下无法解析 `@earendil-works/pi-coding-agent`
 * 等包的**运行时值**（类型导入会被擦除，是安全的），因此把 Pi 的两处调用收进端口后，
 * 测试只需注入假端口即可覆盖会话注册表的全部逻辑，无需改动 `vitest.config.ts` 或 `vi.mock`。
 */
export interface AgentSdkPort {
  /** 创建 agent 会话（生产 = Pi 的 `createAgentSession`）。 */
  createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: AgentSession }>;
  /** 创建内存会话管理器（生产 = `SessionManager.inMemory`）。 */
  createInMemorySessionManager(cwd: string): SessionManager;
}

/** 生产用 SDK 端口：直接委托 Pi SDK。 */
const defaultPort: AgentSdkPort = {
  createAgentSession: (options) => createPiAgentSession(options),
  createInMemorySessionManager: (cwd) => PiSessionManager.inMemory(cwd),
};

/** 会话注册表构造入参。 */
export interface AgentSessionRegistryOptions {
  /** 仓库根目录（配置 / 提示词 / 技能）。 */
  rootDir: string;
  /** 存储根目录（项目目录在其下）。 */
  storageRoot: string;
  /** Drizzle 数据库实例。 */
  db: any;
  /** 系统配置（画布 profile / 并发 / 放开策略）。 */
  config: SystemConfig;
  /** 三级留痕写入器（可选）。 */
  trace?: TraceStore;
  /** 按 actor 解析留痕写入器（TraceStore 绑定单个 actor，不能跨用户复用）；优先于 `trace`。 */
  traceForActor?: (actor: Actor) => TraceStore;
  /**
   * 会话事件出口：会话创建后统一订阅一次 Pi 事件（含阶段执行期间），
   * 由上层映射为 SSE 事件。缺省不订阅。
   */
  onSessionEvent?: (sessionId: string, event: AgentSessionEvent) => void;
  /** 已注册 Ark provider 的模型运行时。 */
  modelRuntime: ModelRuntime;
  /** 使用的具体模型（由 `runtime.ts` 解析）。 */
  model: Model<Api>;
  /** SDK 端口；缺省用真实 Pi SDK。 */
  port?: AgentSdkPort;
  /** 空闲超时毫秒；缺省 `SESSION_IDLE_TIMEOUT_MS`。 */
  idleTimeoutMs?: number;
  /** 时钟注入（便于测试空闲回收）；缺省 `Date.now`。 */
  now?: () => number;
}

/** 会话当前所处 run / 阶段的留痕上下文（由工作流引擎进入阶段时设置，退出时清空）。 */
export interface StageTraceContext {
  runId: string | null;
  stageId: string | null;
}

/** 常驻会话表项。 */
export interface AgentSessionEntry {
  sessionId: string;
  userId: string;
  projectId: string;
  projectDir: string;
  session: AgentSession;
  lastActiveAt: number;
  /** 工具留痕用的可变阶段上下文（同一对象被工具闭包引用）。 */
  stageTrace: StageTraceContext;
  /** 该会话专属的留痕写入器（LLM 留痕按会话取用）；未接留痕时为空。 */
  traceStore?: TraceStore;
  /** 会话事件订阅的退订函数（释放会话时必须调用，避免监听器泄漏）。 */
  unsubscribe?: () => void;
}

/** LLM 留痕目标：会话专属写入器 + 当前 run / 阶段上下文（供 provider 按 sessionId 解析）。 */
export interface SessionLlmTraceTarget {
  trace: TraceStore;
  sessionId: string;
  runId?: string;
  stageId?: string;
}

/** 会话注册表对外能力。 */
export interface AgentSessionRegistry {
  /** 读取内存中的会话（不存在返回 undefined）；不做归属校验，仅按 id 查表。 */
  get(sessionId: string): AgentSessionEntry | undefined;
  /** 取到或创建会话（含历史消息重放）；归属校验失败抛 AUTH_FORBIDDEN。 */
  getOrCreate(actor: Actor, sessionId: string): Promise<AgentSessionEntry>;
  /** 刷新活跃时间（外部在收发消息后调用）。 */
  touch(sessionId: string): void;
  /**
   * 设置会话当前的 run / 阶段留痕上下文；会话不存在时静默返回。
   * 引擎在阶段执行前调用，阶段结束后传 `{ runId: null, stageId: null }` 清空，
   * 使 `tool_calls.run_id` / `stage_id` 能归属到具体阶段而非恒为 null。
   */
  setStageTrace(sessionId: string, context: Partial<StageTraceContext>): void;
  /**
   * 解析某会话的 LLM 留痕目标（写入器 + 当前 run / 阶段）。
   * 供 Ark provider 在发起请求时按 `streamOptions.sessionId` 取用；会话不存在或未接留痕时返回 undefined。
   */
  resolveLlmTraceTarget(sessionId?: string): SessionLlmTraceTarget | undefined;
  /** 释放单个会话（dispose + 从表移除）；不存在时静默返回。 */
  release(sessionId: string): void;
  /** 回收所有超过空闲超时的会话，返回回收数量。 */
  disposeIdle(): number;
  /** 释放全部会话（进程退出用），返回释放数量。 */
  disposeAll(): number;
  /** 当前常驻会话数（供监控/测试）。 */
  readonly size: number;
}

/**
 * 创建会话注册表。
 * @param options 依赖项（根目录 / 存储根 / 数据库 / 配置 / 留痕 / 模型运行时 / 端口与时钟）
 * @returns 会话注册表实例
 */
export function createSessionRegistry(options: AgentSessionRegistryOptions): AgentSessionRegistry {
  const {
    rootDir,
    storageRoot,
    db,
    config,
    trace,
    traceForActor,
    onSessionEvent,
    modelRuntime,
    model,
    port = defaultPort,
    idleTimeoutMs = SESSION_IDLE_TIMEOUT_MS,
    now = Date.now,
  } = options;

  const entries = new Map<string, AgentSessionEntry>();

  /**
   * 释放会话：先 `dispose()` 断开事件并中止活动工作，再移出常驻表。
   * `dispose()` 用 try/catch 包住——单个会话销毁失败不应阻断其余会话回收。
   */
  function releaseEntry(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    // 先退订会话事件，再 dispose，避免销毁期事件继续投递
    try {
      entry.unsubscribe?.();
    } catch (error) {
      console.warn(
        `[session-registry] 退订会话事件失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    try {
      entry.session.dispose();
    } catch (error) {
      console.warn(
        `[session-registry] dispose 会话失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    entries.delete(sessionId);
  }

  return {
    get(sessionId: string): AgentSessionEntry | undefined {
      return entries.get(sessionId);
    },

    async getOrCreate(actor: Actor, sessionId: string): Promise<AgentSessionEntry> {
      // 1) 内存命中：直接复用，但必须先校验归属，防止跨用户拿到别人的会话
      const cached = entries.get(sessionId);
      if (cached) {
        if (cached.userId !== actor.userId) {
          throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${sessionId}`);
        }
        cached.lastActiveAt = now();
        return cached;
      }

      // 2) 未命中：按 actor 查会话（仓储 SQL 层已限定 user_id，越权/不存在都返回 undefined）
      const session = getSession(db, actor, sessionId);
      if (!session) {
        throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${sessionId}`);
      }

      // 3) 解析会话所属项目（同样由仓储做归属校验）
      const project = getProject(db, actor, session.project_id);
      if (!project) {
        throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${session.project_id}`);
      }

      // 4) 项目落盘目录：统一走 path-safety，不做字符串拼接
      const projectDir = resolveUserProjectDir(storageRoot, actor.userId, project.name);

      // 5) 历史消息重放：数据库是唯一来源，逐条 appendMessage 重建 Pi 的持久化上下文
      const manager = port.createInMemorySessionManager(projectDir);
      for (const message of listMessages(db, actor, sessionId)) {
        // 只重放「payload 为对象」的记录；历史消息是外部来源，单条损坏不应让会话无法启动
        const payload = message.payload;
        if (payload === null || typeof payload !== "object") continue;
        try {
          manager.appendMessage(payload as never);
        } catch (error) {
          console.warn(
            `[session-registry] 历史消息重放失败，已跳过：${message.id}（${error instanceof Error ? error.message : String(error)}）`,
          );
        }
      }

      // 6) 组装自定义工具：7 个阶段工具 + 内置工具，按同一 (sessionId, runId, stageId) 挂留痕
      //    runId 由后续工作流引擎在创建 run 时确定，本阶段留空——自由对话暂无 run；
      //    stageId 同理，由引擎进阶段时注入。
      //    留痕写入器按 actor 解析：`createTraceStore` 在创建时绑定单个 actor，
      //    会话注册表是进程级单例，若整表复用同一 store 会导致多用户场景跨用户串写 trace，
      //    故优先用 `traceForActor` 拿到「当前 actor 专属」的 store（缺省回退单一 `trace`）。
      const resolvedTrace = traceForActor ? traceForActor(actor) : trace;
      // 阶段上下文由引擎动态写入；工具闭包通过下面两个 getter 读取「当前值」，
      // 否则会话创建时 runId/stageId 尚不存在，tool_calls 会永远落 null 而查不到。
      const stageTrace: StageTraceContext = { runId: null, stageId: null };
      const customTools = createAgentTools({
        stage: {
          rootDir,
          projectDir,
          // projects.profile 是目录名字符串，需转换为内核使用的 OutputProfile 枚举值
          profile: resolveOutputProfile(rootDir, project.profile),
          style: project.style ?? undefined,
          runId: undefined,
          config,
        },
        builtin: {
          projectDir,
          allowShellWriteEdit: config.agent.allow_shell_write_edit,
          trace: resolvedTrace,
          sessionId,
          runId: () => stageTrace.runId,
          stageId: () => stageTrace.stageId,
        },
      });

      // 7) 资源加载器：注入系统提示与技能目录（绝对路径）
      const resourceLoader = createAgentResourceLoader({
        rootDir,
        projectDir,
        agentDir: resolveAgentDir(rootDir),
      });

      // 8) 创建会话：`noTools: "builtin"` 必须——内置工具已由 createBuiltinTools（带留痕）自己提供，
      //    若不禁用 Pi 自带内置工具会出现重名工具。
      const { session: agentSession } = await port.createAgentSession({
        cwd: projectDir,
        agentDir: resolveAgentDir(rootDir),
        modelRuntime,
        model,
        sessionManager: manager,
        resourceLoader,
        customTools,
        noTools: "builtin",
      });

      // 9) 统一订阅一次会话事件（含阶段执行期间），避免工作流与自由对话并发时重复推送
      const unsubscribe =
        onSessionEvent && typeof agentSession.subscribe === "function"
          ? agentSession.subscribe((event: AgentSessionEvent) => {
              try {
                onSessionEvent(sessionId, event);
              } catch (error) {
                console.warn(
                  `[session-registry] 会话事件转发失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`,
                );
              }
            })
          : undefined;

      // 10) 写表并刷新活跃时间
      const entry: AgentSessionEntry = {
        sessionId,
        userId: actor.userId,
        projectId: session.project_id,
        projectDir,
        session: agentSession,
        lastActiveAt: now(),
        stageTrace,
        // 留痕写入器按 actor 解析后固化到会话，LLM 留痕按 sessionId 反查即用
        traceStore: resolvedTrace,
        unsubscribe,
      };
      entries.set(sessionId, entry);
      console.info(`[session-registry] 已创建会话：${sessionId}（项目 ${session.project_id}）`);
      return entry;
    },

    touch(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.lastActiveAt = now();
    },

    setStageTrace(sessionId: string, context: Partial<StageTraceContext>): void {
      const entry = entries.get(sessionId);
      if (!entry) return;
      // 就地修改同一对象：工具闭包持有该引用，无需重建工具
      if (context.runId !== undefined) entry.stageTrace.runId = context.runId;
      if (context.stageId !== undefined) entry.stageTrace.stageId = context.stageId;
    },

    resolveLlmTraceTarget(sessionId?: string): SessionLlmTraceTarget | undefined {
      if (!sessionId) return undefined;
      const entry = entries.get(sessionId);
      if (!entry?.traceStore) return undefined;
      return {
        trace: entry.traceStore,
        sessionId: entry.sessionId,
        runId: entry.stageTrace.runId ?? undefined,
        stageId: entry.stageTrace.stageId ?? undefined,
      };
    },

    release(sessionId: string): void {
      releaseEntry(sessionId);
    },

    disposeIdle(): number {
      const current = now();
      const idleIds: string[] = [];
      for (const [sessionId, entry] of entries) {
        if (current - entry.lastActiveAt >= idleTimeoutMs) idleIds.push(sessionId);
      }
      for (const sessionId of idleIds) releaseEntry(sessionId);
      return idleIds.length;
    },

    disposeAll(): number {
      const count = entries.size;
      for (const sessionId of [...entries.keys()]) releaseEntry(sessionId);
      return count;
    },

    get size(): number {
      return entries.size;
    },
  };
}
