import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const timestamp = () => text("created_at").notNull();

// ---------------------------------------------------------------------------
// 新领域模型（见设计文档 §11 数据模型）。
// 字段名与 §11 表格逐字对齐；JSON 负载列（payload / args_json / request_json /
// response_json / artifact_paths）一律用 TEXT 存 JSON 字符串。
// ---------------------------------------------------------------------------

/**
 * 用户表（见设计文档 §11 `users`）。
 * 大小写不敏感唯一方案：**写入前统一 `toLowerCase()` 归一化后存储，查询/比对前同样归一化**，
 * 因此仅需对 `username` 建唯一索引即可实现“大小写不敏感唯一”，不额外增加 `username_lower` 列。
 */
export const users = sqliteTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    /** `role ∈ admin|user`（见设计文档 §8.2）。 */
    role: text("role").notNull().default("user"),
    /** 初始化 / 重置密码后置 1，改密成功后置 0（落库 0/1）。 */
    mustChangePassword: integer("must_change_password", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: timestamp(),
    lastLoginAt: text("last_login_at"),
  },
  (table) => [uniqueIndex("idx_users_username").on(table.username)],
);

/**
 * 项目表（见设计文档 §11 `projects`）。
 * 与旧 Build 领域的 `projects` 同名但语义不同（§10.1 要求同名替换）。
 * `unique(user_id, name)` 约束用户范围内的项目名唯一（冲突时由服务端追加 `-2`、`-3`…，见 §8.3）。
 */
export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    userId: text("user_id").notNull(),
    /** 引用能力注册表（当前仅 `video-generation`，见设计文档 §3.6）。 */
    capabilityId: text("capability_id").notNull(),
    name: text("name").notNull(),
    topic: text("topic").notNull(),
    style: text("style"),
    /** 输出 Profile 名（默认 `landscape-1080p`，见设计文档 §6.1）。 */
    profile: text("profile").notNull(),
    /** `status ∈ draft|running|review|done|failed`（见设计文档 §8.4）。 */
    status: text("status").notNull().default("draft"),
    createdAt: timestamp(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_projects_user_name").on(table.userId, table.name)],
);

/** 会话表（纯对话容器；租约语义由 `runs` 承担），见设计文档 §11 `sessions`。 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_sessions_project").on(table.projectId)],
);

/** 消息表，见设计文档 §11 `messages`；`payload` 存 JSON 文本。 */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    sessionId: text("session_id").notNull(),
    /** 便于按 run 过滤叙述；自由对话时为空（见设计文档 §6.3）。 */
    runId: text("run_id"),
    /** `role ∈ user|assistant|tool|system`。 */
    role: text("role").notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp(),
  },
  (table) => [index("idx_messages_session").on(table.sessionId)],
);

/** 任务运行表，见设计文档 §11 `runs`；run 是项目租约的载体（见 §8.4）。 */
export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** `status ∈ queued|running|waiting_review|done|failed|canceled`。 */
    status: text("status").notNull(),
    /** `trigger ∈ user|retry|resume`。 */
    trigger: text("trigger").notNull(),
    currentStage: text("current_stage"),
    errorCode: text("error_code"),
    createdAt: timestamp(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (table) => [
    index("idx_runs_project").on(table.projectId),
    index("idx_runs_status").on(table.status),
  ],
);

/** 阶段实例表，见设计文档 §11 `run_stages`；`artifact_paths` 存 JSON 文本。 */
export const runStages = sqliteTable(
  "run_stages",
  {
    id: id(),
    runId: text("run_id").notNull(),
    /** `stage ∈ copy|image|scene|tts|storyboard|render|compose`。 */
    stage: text("stage").notNull(),
    /** `status ∈ pending|running|done|failed|skipped`。 */
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    errorCode: text("error_code"),
    artifactPaths: text("artifact_paths").notNull().default("[]"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (table) => [index("idx_run_stages_run").on(table.runId)],
);

/** 工具调用留痕表，见设计文档 §11 `tool_calls` 与 §7.3；`args_json` / `artifact_paths` 存 JSON 文本。 */
export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: id(),
    sessionId: text("session_id").notNull(),
    /** 自由对话时为空（见设计文档 §7.1）。 */
    runId: text("run_id"),
    /** 自由对话时为空（见设计文档 §7.1）。 */
    stageId: text("stage_id"),
    tool: text("tool").notNull(),
    argsJson: text("args_json").notNull(),
    /** 调用是否成功（落库 0/1）。 */
    ok: integer("ok", { mode: "boolean" }).notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    artifactPaths: text("artifact_paths").notNull().default("[]"),
    createdAt: timestamp(),
  },
  (table) => [
    index("idx_tool_calls_session").on(table.sessionId),
    index("idx_tool_calls_run").on(table.runId),
  ],
);

/** LLM 调用全文留痕表，见设计文档 §11 `llm_calls` 与 §7.2；JSON 文本列落库前过脱敏器。 */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: id(),
    sessionId: text("session_id").notNull(),
    runId: text("run_id"),
    stageId: text("stage_id"),
    model: text("model").notNull(),
    requestJson: text("request_json").notNull(),
    responseJson: text("response_json").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** 调用是否成功（落库 0/1）。 */
    ok: integer("ok", { mode: "boolean" }).notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp(),
  },
  (table) => [
    index("idx_llm_calls_session").on(table.sessionId),
    index("idx_llm_calls_run").on(table.runId),
  ],
);
