import Fastify, { type FastifyInstance } from "fastify";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { loadSystemConfig } from "@videoforge/pipeline";
import type { Actor, Message } from "@videoforge/shared";
import { createDatabase, migrateDatabase } from "./db/index.js";
import { getProject } from "./db/repositories/project-repository.js";
import { ensureAdminUser } from "./auth/bootstrap.js";
import { registerJwt } from "./auth/jwt.js";
import { loadJwtSecret } from "./auth/secret.js";
import { createAgentRuntime } from "./agent/runtime.js";
import type { AgentSessionRegistry } from "./agent/session-registry.js";
import { createTraceStore, type TraceStore } from "./trace/trace-store.js";
import { createLoggerOptions } from "./trace/logger.js";
import { createRedactor } from "./trace/redact.js";
import {
  createWorkflowEngine,
  type StageExecutionRequest,
  type StageExecutionResult,
  type StageExecutor,
  type WorkflowEvent,
} from "./workflow/engine.js";
import { recoverInterruptedRuns } from "./workflow/lease.js";
import { listStageArtifacts } from "./workflow/breakpoint.js";
import { getCapability } from "./workflow/capabilities.js";
import { createEventBus, type EventBus } from "./http/event-bus.js";
import { registerHttpRoutes } from "./http/index.js";
import type { ChatPort, HttpDeps } from "./http/deps.js";

/**
 * 服务端装配根（见设计文档 §4.2/§4.4/§11）。
 *
 * 本文件只做「组装 + 启动编排」：把 HTTP 层依赖（数据库 / 配置 / 事件总线 / 工作流引擎 / 对话端口）
 * 按依赖顺序拼起来，再交给 `registerHttpRoutes` 注册全部 REST/SSE 路由。
 * 具体路由行为与领域逻辑分别位于 `src/http`、`src/workflow`、`src/agent`。
 */

// ---------------------------------------------------------------------------
// 组装入参
// ---------------------------------------------------------------------------

/** `createApp` 的构造入参。 */
export interface CreateAppOptions {
  /** HTTP 层运行期依赖（由 startServer 组装；测试可注入假实现）。 */
  deps: HttpDeps;
  /** 已解析的 JWT 密钥（来自环境变量，禁止落盘/打印）。 */
  jwtSecret: string;
  /** 是否启用结构化日志（默认启用且经脱敏）；测试可传 false。 */
  logging?: boolean;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从已落库的用户消息载荷中安全取出文本。
 * 载荷形状为 `{ role: "user", content: string }`（见 `http/routes/sessions.ts`），
 * 但 `payload` 类型为 `unknown`，故做类型守卫取值，非对象或不含字符串 content 时返回空串。
 * @param payload 消息载荷
 * @returns 用户文本（取不到为空串）
 */
function extractUserText(payload: unknown): string {
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}

/**
 * 依据能力声明的阶段产物判据列出实际命中的产物相对路径。
 * 只做「列出」，不做达标判定——达标由工作流引擎的 `verifyStageArtifact` 裁决。
 * 项目 / 能力 / 阶段声明任一解析不到时返回空数组（让引擎按未达标收口，避免误报执行器故障）。
 * @param db Drizzle 数据库实例
 * @param request 阶段执行请求
 * @returns 命中的产物相对路径数组
 */
function resolveArtifactPaths(db: any, request: StageExecutionRequest): string[] {
  const project = getProject(db, request.actor, request.projectId);
  if (!project) return [];
  const capability = getCapability(project.capability_id);
  if (!capability) return [];
  const declaration = capability.stages.find((stage) => stage.stage === request.stage);
  if (!declaration) return [];
  return listStageArtifacts(request.projectDir, declaration.artifact, request.profile);
}

// ---------------------------------------------------------------------------
// agent 会话事件 → SSE
// ---------------------------------------------------------------------------

/**
 * 把 Pi 的 `AgentSessionEvent` 映射为设计文档 §4.4 的 SSE 事件并发布到所属会话。
 *
 * 事件映射：
 * - `message_update` 且 `assistantMessageEvent.type === "text_delta"` → `text_delta`，载荷 `{ text: delta }`；
 * - `tool_execution_start` → `tool_start`，载荷 `{ toolCallId, tool, args, startedAt }`（Pi 字段名为 `toolName`，SSE 用 `tool`）；
 * - `tool_execution_end` → `tool_end`，载荷 `{ toolCallId, ok: !isError, durationMs }`（Pi 无 `errorCode` 字段，不臆造）；
 * - `turn_end` → `turn_end`，载荷 `{ message }`；其它事件忽略。
 *
 * 由会话注册表在**创建会话时统一订阅一次**（而非每次对话 / 每个阶段各订阅一次），
 * 避免工作流阶段与自由对话并发时同一事件被重复推送。
 * @param eventBus 会话级事件总线
 * @param sessionId 会话 id
 * @param event Pi 会话事件
 */
function publishAgentSessionEvent(
  eventBus: EventBus,
  sessionId: string,
  event: AgentSessionEvent,
): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    eventBus.publish(sessionId, "text_delta", { text: event.assistantMessageEvent.delta });
  } else if (event.type === "tool_execution_start") {
    eventBus.publish(sessionId, "tool_start", {
      toolCallId: event.toolCallId,
      tool: event.toolName,
      args: event.args,
      // 建卡时间用于前端展示「已运行」计时，长阶段工具（生图 / 场景）靠它判断是否仍在跑
      startedAt: new Date().toISOString(),
    });
  } else if (event.type === "tool_execution_end") {
    eventBus.publish(sessionId, "tool_end", {
      toolCallId: event.toolCallId,
      ok: !event.isError,
      durationMs: event.durationMs,
    });
  } else if (event.type === "turn_end") {
    eventBus.publish(sessionId, "turn_end", { message: event.message });
  }
}

// ---------------------------------------------------------------------------
// 对话端口（ChatPort）实现
// ---------------------------------------------------------------------------

/**
 * 创建生产用对话端口：把用户消息下发给 Pi agent 会话。
 *
 * 流式增量（文本 / 工具 / 轮次结束）统一由会话注册表的全局订阅转发为 SSE 事件
 * （见 `publishAgentSessionEvent`），本端口只负责下发与收尾，不重复订阅，避免事件重复推送。
 * @param options 会话注册表
 * @returns ChatPort 实例
 */
function createChatPort(options: { sessions: AgentSessionRegistry }): ChatPort {
  const { sessions } = options;
  return {
    /** 下发一条用户消息并等待本轮结束。 */
    async send(actor: Actor, sessionId: string, message: Message): Promise<void> {
      const entry = await sessions.getOrCreate(actor, sessionId);
      try {
        const text = extractUserText(message.payload);
        // 流式期调用 prompt 必须显式指定 streamingBehavior，否则 Pi 会拒绝该调用
        await entry.session.prompt(
          text,
          entry.session.isStreaming ? { streamingBehavior: "followUp" } : undefined,
        );
      } finally {
        sessions.touch(sessionId);
      }
    },

    /** 中断当前自由对话轮：会话不存在或不属于 actor 时静默返回，abort 失败只告警不抛出。 */
    abort(actor: Actor, sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (!entry || entry.userId !== actor.userId) return;
      void entry.session.abort().catch((error: unknown) => {
        console.warn(
          `[app] 中断会话失败：${sessionId}（${error instanceof Error ? error.message : String(error)}）`,
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 阶段执行器（StageExecutor）实现
// ---------------------------------------------------------------------------

/**
 * 创建工作流引擎的阶段执行器：把阶段指令下发给 agent 会话并回报产物清单。
 *
 * 分工说明：阶段指令**已由引擎自己落库**（`engine.ts` 在 `stage_started` 前 `appendMessage(role:"system")`），
 * 故执行器**不重复落库**指令；达标判定同样由引擎的 `verifyStageArtifact` 完成，执行器只回报产物清单。
 * @param options 数据库与会话注册表
 * @returns StageExecutor 实例
 */
function createStageExecutor(options: { db: any; sessions: AgentSessionRegistry }): StageExecutor {
  const { db, sessions } = options;
  return async (request: StageExecutionRequest): Promise<StageExecutionResult> => {
    const entry = await sessions.getOrCreate(request.actor, request.sessionId);
    // 进入阶段即绑定 run / 阶段上下文：阶段工具的 tool_calls 才能按 run 归属（trace 页据此过滤）
    sessions.setStageTrace(request.sessionId, { runId: request.runId, stageId: request.stageId });
    try {
      // 阶段指令为长任务，执行器本身不设并发控制（引擎已用全局信号量限流）
      await entry.session.prompt(
        request.instruction,
        entry.session.isStreaming ? { streamingBehavior: "followUp" } : undefined,
      );
    } catch (error: unknown) {
      console.warn(
        `[app] 阶段 ${request.stage} 指令下发失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, errorCode: "TOOL_UNAVAILABLE" };
    } finally {
      // 阶段结束后清空，避免自由对话期间的调用被错误归属到上一个 run
      sessions.setStageTrace(request.sessionId, { runId: null, stageId: null });
      sessions.touch(request.sessionId);
    }
    return { ok: true, artifactPaths: resolveArtifactPaths(db, request) };
  };
}

// ---------------------------------------------------------------------------
// 工作流事件 → SSE 事件总线映射
// ---------------------------------------------------------------------------

/**
 * 把工作流引擎事件映射为设计文档 §4.4 的 SSE 事件并发布到所属会话。
 *
 * 映射表（引擎事件 → SSE 事件）：
 * - `run_started` → `run_start`，载荷 `{ runId, trigger: "auto" }`；
 * - `stage_started` → `run_stage`，载荷 `{ runId, stage, status: "running", attempt }`；
 * - `stage_done` → `run_stage`，载荷 `{ runId, stage, status: "done", attempt, artifactPaths }`；
 * - `stage_failed` → `run_stage`，载荷 `{ runId, stage, status: "failed", attempt, errorCode }`；
 * - `review_gate` → `review_gate`，载荷 `{ runId, stage, summary }`；
 * - `run_done` → `run_end`，载荷 `{ runId, status: "done" }`；
 * - `run_failed` → `run_end`，载荷 `{ runId, status: "failed", errorCode }`；
 * - `run_canceled` → `run_end`，载荷 `{ runId, status: "canceled" }`。
 *
 * 受控偏差（登记到本任务报告）：
 * ① `run_start`：§4.4 要求 `{ runId, trigger, fromStage }`，但引擎在 `run_started` 时未提供 `fromStage`，
 *    本次不下发该字段；
 * ② `review_gate`：§4.4 要求 `{ runId, stage, summary }`，引擎 payload 只给 `{ artifactPaths }`，
 *    故 `summary` 由 `artifactPaths` 派生（有产物则拼接路径，无产物则给固定文案）。
 * @param eventBus 事件总线
 * @param event 工作流引擎事件
 */
function forwardWorkflowEvent(eventBus: EventBus, event: WorkflowEvent): void {
  switch (event.type) {
    case "run_started":
      // 受控偏差①：不下发 fromStage
      eventBus.publish(event.sessionId, "run_start", { runId: event.runId, trigger: "auto" });
      break;
    case "stage_started":
      eventBus.publish(event.sessionId, "run_stage", {
        runId: event.runId,
        stage: event.stage,
        status: "running",
        attempt: event.payload?.attempt,
        // 前端据此展示运行中阶段的实时耗时（否则 SSE 先到的 running 态没有起点）
        startedAt: event.payload?.startedAt,
      });
      break;
    case "stage_done":
      eventBus.publish(event.sessionId, "run_stage", {
        runId: event.runId,
        stage: event.stage,
        status: "done",
        attempt: event.payload?.attempt,
        artifactPaths: event.payload?.artifactPaths,
        endedAt: event.payload?.endedAt,
      });
      break;
    case "stage_failed":
      eventBus.publish(event.sessionId, "run_stage", {
        runId: event.runId,
        stage: event.stage,
        status: "failed",
        attempt: event.payload?.attempt,
        errorCode: event.payload?.errorCode ?? null,
        endedAt: event.payload?.endedAt,
      });
      break;
    case "review_gate": {
      // 受控偏差②：summary 由 artifactPaths 派生
      const artifactPaths = (event.payload?.artifactPaths as string[] | undefined) ?? [];
      const summary = artifactPaths.length ? artifactPaths.join("、") : "阶段产物已就绪，等待确认";
      eventBus.publish(event.sessionId, "review_gate", {
        runId: event.runId,
        stage: event.stage,
        summary,
      });
      break;
    }
    case "run_done":
      eventBus.publish(event.sessionId, "run_end", { runId: event.runId, status: "done" });
      break;
    case "run_failed":
      eventBus.publish(event.sessionId, "run_end", {
        runId: event.runId,
        status: "failed",
        errorCode: event.payload?.errorCode ?? null,
      });
      break;
    case "run_canceled":
      eventBus.publish(event.sessionId, "run_end", { runId: event.runId, status: "canceled" });
      break;
  }
}

// ---------------------------------------------------------------------------
// 应用工厂
// ---------------------------------------------------------------------------

/**
 * 创建 VideoForge Fastify 应用：注册 JWT 插件、健康检查与全部 HTTP 路由。
 * JWT 必须在 `registerHttpRoutes` 之前注册，因为 auth-hook / event-ticket 依赖 `app.jwt`。
 * @param options HTTP 依赖、已解析的 JWT 密钥与日志开关
 * @returns 已注册路由的 Fastify 实例
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logging === false ? false : createLoggerOptions(createRedactor(options.deps.rootDir)),
  });

  // 先注册 JWT 插件（鉴权钩子与 SSE 票据依赖 app.jwt）
  await registerJwt(app, options.deps.config, options.jwtSecret);

  // 健康检查：集成测试与冷启动探活依赖该端点
  app.get("/health", async () => ({ status: "ok", service: "videoforge-server" }));

  // 注册全部 REST/SSE 路由与统一错误处理
  registerHttpRoutes(app, options.deps);

  return app;
}

// ---------------------------------------------------------------------------
// 启动编排
// ---------------------------------------------------------------------------

/**
 * 加载配置、迁移数据库、组装运行时与工作流引擎，并监听 127.0.0.1。
 *
 * 编排顺序（任一步失败都保证关库，避免句柄泄漏）：
 * 根目录 → 配置 → JWT 密钥（快速失败）→ 存储根 → 迁移+开库 → admin 初始化 → 中断恢复 →
 * 事件总线 → 按 actor 的 trace store → agent 运行时 → 阶段执行器 → 工作流引擎 → 对话端口 →
 * HTTP 依赖 → 应用 → 就绪日志 → 空闲回收定时器 → 退出钩子 → 监听。
 * @param options 项目根目录与测试/调用方配置覆盖
 * @returns 正在监听的 Fastify 实例
 */
export async function startServer(
  options: {
    rootDir?: string;
    configOverride?: Record<string, unknown>;
  } = {},
): Promise<FastifyInstance> {
  // 1) 根目录：缺省由本文件位置回溯到仓库根
  const rootDir = options.rootDir ?? fileURLToPath(new URL("../../..", import.meta.url));

  // 2) 加载系统配置（含本机覆盖）
  const config = loadSystemConfig({ rootDir, override: options.configOverride });

  // 3) JWT 密钥：缺失或过短即快速失败；绝不打印密钥值
  const jwtSecret = loadJwtSecret(config, rootDir);

  // 4) 确保存储根目录存在
  await mkdir(config.runtime.storage_root, { recursive: true });

  // 5) 迁移并打开数据库
  const databasePath = resolve(config.runtime.storage_root, "videoforge.db");
  migrateDatabase(databasePath);
  const { db, sqlite } = createDatabase(databasePath);

  // 关库收口：多处失败路径共用一个幂等关闭器，避免重复 close 抛错
  let closed = false;
  const closeDatabase = (): void => {
    if (closed) return;
    closed = true;
    sqlite.close();
  };

  let app: FastifyInstance;
  try {
    // 6) 幂等初始化内置 admin（已存在则原样跳过）
    const admin = ensureAdminUser({ db, config, rootDir });

    // 7) 启动恢复：把上次异常中断的 run 收口为 canceled/INTERRUPTED
    const recovered = recoverInterruptedRuns(db);

    // 8) 会话级 SSE 事件总线
    const eventBus = createEventBus();

    // 9) 按 actor 缓存 trace store：store 在创建时绑定单个 actor，
    //    禁止跨用户复用一份，故以 userId 为键缓存，每个 actor 各持己用。
    const traceStores = new Map<string, TraceStore>();
    const traceForActor = (actor: Actor): TraceStore => {
      let store = traceStores.get(actor.userId);
      if (!store) {
        store = createTraceStore({
          db,
          actor,
          storageRoot: config.runtime.storage_root,
          rootDir,
        });
        traceStores.set(actor.userId, store);
      }
      return store;
    };

    // 10) agent 运行时：模型 provider 注册 + 模型解析 + 会话注册表。
    //     会话创建时统一订阅 Pi 事件并转发为 SSE，阶段执行期间同样可见实时进度。
    const runtime = await createAgentRuntime({
      rootDir,
      storageRoot: config.runtime.storage_root,
      db,
      config,
      traceForActor,
      onSessionEvent: (sessionId, event) => publishAgentSessionEvent(eventBus, sessionId, event),
    });

    // 11) 阶段执行器：驱动 agent 会话并回报产物清单
    const executeStage = createStageExecutor({ db, sessions: runtime.sessions });

    // 12) 工作流引擎：事件出口接到 SSE 事件总线；阶段状态变更同步双写 trace.jsonl
    const workflow = createWorkflowEngine({
      db,
      storageRoot: config.runtime.storage_root,
      config,
      executeStage,
      emit: (event) => forwardWorkflowEvent(eventBus, event),
      onStageChange: (record) => {
        const { actor, ...stage } = record;
        traceForActor(actor).recordStage(stage);
      },
    });

    // 13) 对话端口
    const chat = createChatPort({ sessions: runtime.sessions });

    // 14) HTTP 层依赖
    const deps: HttpDeps = {
      db,
      config,
      rootDir,
      storageRoot: config.runtime.storage_root,
      eventBus,
      workflow,
      chat,
    };

    // 15) 创建应用
    app = await createApp({ deps, jwtSecret, logging: true });

    // 16) 就绪日志（不含任何密钥）：模型 provider/ID、阶段并发上限、中断恢复条数、admin 是否新建
    app.log.info(
      {
        modelProvider: "ark",
        model: runtime.model.id,
        maxConcurrentStage: config.runtime.max_concurrent_stage,
        recoveredRuns: recovered,
        adminCreated: admin.created,
      },
      "agent 运行时与工作流引擎已就绪",
    );

    // 17) 空闲会话回收定时器（每分钟一次；unref 不阻止进程退出）
    const idleTimer = setInterval(() => {
      const released = runtime.sessions.disposeIdle();
      if (released > 0) app.log.info({ released }, "空闲会话已回收");
    }, 60_000);
    idleTimer.unref();

    // 18) 退出钩子：清定时器 + 释放全部会话 + 关库
    app.addHook("onClose", async () => {
      clearInterval(idleTimer);
      runtime.sessions.disposeAll();
      closeDatabase();
    });
  } catch (error) {
    // 初始化阶段任一步失败：保证关库后抛出原始错误
    closeDatabase();
    throw error;
  }

  // 19) 监听本机回环地址（严禁改为公网绑定）
  try {
    await app.listen({ port: config.server.port, host: "127.0.0.1" });
  } catch (error) {
    closeDatabase();
    throw error;
  }
  app.log.info(`server listening on http://127.0.0.1:${config.server.port}`);
  return app;
}

// ---------------------------------------------------------------------------
// 直接运行入口（`pnpm run server:dev` → tsx src/app.ts）
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer()
    .then((app) => {
      /**
       * 优雅退出：收到 SIGINT/SIGTERM 后关闭应用（触发 onClose：清定时器 + 释放会话 + 关库）。
       * 关闭失败也强制退出，避免进程挂死。
       */
      const shutdown = (signal: NodeJS.Signals): void => {
        app.log.info({ signal }, "收到退出信号，正在优雅关闭");
        app
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(0));
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      console.error("[server] failed to start:", error);
      process.exitCode = 1;
    });
}
