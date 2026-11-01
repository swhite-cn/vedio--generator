/** 输出画幅 Profile（渲染内核与阶段工具共用）。 */
export type OutputProfile = "LANDSCAPE_1080P" | "PORTRAIT_1080P";

// ---------------------------------------------------------------------------
// 以下为重构后的新领域模型（见设计文档 §11 数据模型）。
// 字段名与设计文档 §11 表逐字一致。
// ---------------------------------------------------------------------------

/** 用户角色集合，见设计文档 §11 `users.role` 与 §8.2。 */
export const USER_ROLES = ["admin", "user"] as const;
/** 用户角色，见设计文档 §11。 */
export type UserRole = (typeof USER_ROLES)[number];

/** 用户，见设计文档 §11 `users` 表。 */
export interface User {
  id: string;
  /** 不区分大小写唯一。 */
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  /** 初始化 / 重置密码后为 true（落库 0/1），改密成功后为 false。 */
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** 项目状态集合，见设计文档 §11 `projects.status`。 */
export const PROJECT_STATUSES = ["draft", "running", "review", "done", "failed"] as const;
/** 项目状态，见设计文档 §11。 */
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 项目，见设计文档 §11 `projects` 表。 */
export interface Project {
  id: string;
  user_id: string;
  /** 引用能力注册表（当前仅 `video-generation`，见设计文档 §3.6）。 */
  capability_id: string;
  name: string;
  topic: string;
  style: string | null;
  /** 输出 Profile 名（默认 `landscape-1080p`，见设计文档 §6.1）。 */
  profile: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

/** 会话（纯对话容器；租约语义由 runs 承担），见设计文档 §11 `sessions` 表与 §8.4。 */
export interface Session {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 消息角色集合，见设计文档 §11 `messages.role`。 */
export const MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;
/** 消息角色，见设计文档 §11。 */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** 消息，见设计文档 §11 `messages` 表。 */
export interface Message {
  id: string;
  session_id: string;
  /** 便于按 run 过滤叙述；自由对话时为空，见设计文档 §11、§6.3。 */
  run_id?: string;
  role: MessageRole;
  /** 消息负载，存 JSON 文本。 */
  payload: unknown;
  created_at: string;
}

/** 运行状态集合，见设计文档 §11 `runs.status` 与 §6.2 状态机。 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_review",
  "done",
  "failed",
  "canceled",
] as const;
/** 运行状态，见设计文档 §11。 */
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 运行触发方式集合，见设计文档 §11 `runs.trigger`。 */
export const RUN_TRIGGERS = ["user", "retry", "resume"] as const;
/** 运行触发方式，见设计文档 §11。 */
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** 流水线阶段集合（有序，即为阶段顺序），见设计文档 §6.1、§11。 */
export const PIPELINE_STAGES = [
  "copy",
  "image",
  "scene",
  "tts",
  "storyboard",
  "render",
  "compose",
] as const;
/** 流水线阶段，见设计文档 §6.1。 */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** 审核点阶段集合（固定在 copy、image 之后），见设计文档 §6.4。 */
export const REVIEW_GATE_STAGES = ["copy", "image"] as const;
/** 审核点阶段，见设计文档 §6.4。 */
export type ReviewGateStage = (typeof REVIEW_GATE_STAGES)[number];

/** 任务运行，见设计文档 §11 `runs` 表；run 是项目租约的载体，见 §8.4。 */
export interface Run {
  id: string;
  project_id: string;
  session_id: string;
  status: RunStatus;
  trigger: RunTrigger;
  /** 当前阶段；无活跃阶段时为空。 */
  current_stage: PipelineStage | null;
  /** 失败时写入的错误码；进程重启中断时取 `RUN_ERROR_INTERRUPTED`。 */
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** 阶段实例状态集合，见设计文档 §11 `run_stages.status` 与 §6.2 状态机。 */
export const RUN_STAGE_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
/** 阶段实例状态，见设计文档 §11。 */
export type RunStageStatus = (typeof RUN_STAGE_STATUSES)[number];

/** 阶段实例，见设计文档 §11 `run_stages` 表。 */
export interface RunStage {
  id: string;
  run_id: string;
  stage: PipelineStage;
  status: RunStageStatus;
  attempt: number;
  error_code: string | null;
  /** 阶段产物路径列表，存 JSON 文本。 */
  artifact_paths: string[];
  started_at: string | null;
  ended_at: string | null;
}

/** 工具调用留痕，见设计文档 §11 `tool_calls` 表与 §7.3。 */
export interface ToolCall {
  id: string;
  session_id: string;
  /** 自由对话时为空，见设计文档 §11。 */
  run_id?: string;
  /** 自由对话时为空，见设计文档 §11。 */
  stage_id?: string;
  tool: string;
  /** 工具参数，存 JSON 文本。 */
  args_json: unknown;
  /** 工具是否成功（落库 0/1）。 */
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  /** 产出工件路径列表，存 JSON 文本。 */
  artifact_paths: string[];
  created_at: string;
}

/** LLM 调用全文留痕，见设计文档 §11 `llm_calls` 表与 §7.2。 */
export interface LlmCall {
  id: string;
  session_id: string;
  run_id?: string;
  stage_id?: string;
  model: string;
  /** LLM 请求体，存 JSON 文本，落库前过脱敏器。 */
  request_json: unknown;
  /** LLM 响应体，存 JSON 文本，落库前过脱敏器。 */
  response_json: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  /** 调用是否成功（落库 0/1）。 */
  ok: boolean;
  error_code: string | null;
  created_at: string;
}

/** 请求主体身份，见设计文档 §8.3（actor-first 仓储签名）。 */
export interface Actor {
  userId: string;
  role: UserRole;
}
