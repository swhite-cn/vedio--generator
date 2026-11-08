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
  /** 项目主题 ID（创建时快照；旧项目为空）。 */
  theme_id: string | null;
  /** 契约版本：`1.0` 七阶段旧链路，`2.0` shots/cue 链路。 */
  contract_version: string;
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

/** 项目资产来源集合。 */
export const PROJECT_ASSET_SOURCES = ["generated", "uploaded"] as const;
/** 项目资产来源。 */
export type ProjectAssetSource = (typeof PROJECT_ASSET_SOURCES)[number];

/** 项目资产类型集合。 */
export const PROJECT_ASSET_KINDS = [
  "document",
  "image",
  "audio",
  "copy",
  "scene",
  "timeline",
  "video",
  "frames",
] as const;
/** 项目资产类型。 */
export type ProjectAssetKind = (typeof PROJECT_ASSET_KINDS)[number];

/** 素材库展示分类（与资产 kind 正交，见重构方案 §8.5 素材库）。 */
export const PROJECT_VISUAL_CATEGORIES = [
  "ai-generated",
  "live-action",
  "archive-photo",
  "3d-render",
  "video-clip",
  "style-anchor",
] as const;
/** 素材库展示分类。 */
export type ProjectVisualCategory = (typeof PROJECT_VISUAL_CATEGORIES)[number];

/** 项目资产（用户上传或流水线生成）。 */
export interface ProjectAsset {
  id: string;
  project_id: string;
  source: ProjectAssetSource;
  kind: ProjectAssetKind;
  /** 素材库展示分类；旧数据为空，由同步逻辑按来源推断。 */
  visual_category: ProjectVisualCategory | null;
  label: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  run_id: string | null;
  stage: PipelineStage | null;
  supersedes_asset_id: string | null;
  metadata_json: unknown;
  created_at: string;
}

/** 一条消息和一个项目资产之间的引用。 */
export interface MessageAssetRef {
  id: string;
  message_id: string;
  asset_id: string;
  ordinal: number;
  created_at: string;
}

/** Agent 动作类型。 */
export const AGENT_ACTION_KINDS = [
  "analyze",
  "reversible_edit",
  "regenerate",
  "render",
  "compose",
] as const;
/** Agent 动作类型。 */
export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

/** Agent 动作状态。 */
export const AGENT_ACTION_STATUSES = [
  "executing",
  "waiting_confirmation",
  "done",
  "failed",
  "canceled",
] as const;
/** Agent 动作状态。 */
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

/** Agent 对用户素材请求产生的结构化动作记录。 */
export interface AgentAction {
  id: string;
  project_id: string;
  session_id: string;
  message_id: string;
  kind: AgentActionKind;
  status: AgentActionStatus;
  plan_json: unknown;
  run_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * 流水线阶段集合（有序，即为阶段顺序），见设计文档 §6.1、§11、重构方案 §4.4。
 * v2 八阶段：`captions`（独立字幕轨）位于 `tts` 之后、`storyboard` 之前，
 * 因为字幕只依赖 cue，而时间轴需要合并 cue 与镜头切点。
 */
export const PIPELINE_STAGES = [
  "copy",
  "image",
  "scene",
  "tts",
  "captions",
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
  /** 镜头级重生成范围；整片 run 为空。 */
  scope_json: RunScope | null;
  /** 创建 run 时的契约版本快照。 */
  contract_version: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * run 的执行范围：用于镜头级重生成。
 * 为空表示整片 run；`shotIds` 只允许命中当前项目 copy v2 中的镜头。
 */
export interface RunScope {
  /** 目标镜头 ID 列表；为空表示全部镜头。 */
  shotIds?: string[];
  /** 从哪个阶段开始重跑；缺省按受影响阶段推断。 */
  fromStage?: PipelineStage;
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
  /** 工具输出预览（截断后的纯文本；全文不落库，见设计文档 §7.3）。 */
  output_preview?: string | null;
  /** 输出是否被截断。 */
  output_truncated?: boolean;
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

/** 登录事件（追加式），供管理页登录日志展示；不记录密码。 */
export interface LoginEvent {
  id: string;
  /** 命中的用户 ID；用户不存在或密码错误时为空。 */
  user_id: string | null;
  /** 登录时输入的用户名。 */
  username: string;
  ok: boolean;
  /** 失败原因短码；成功时为空。 */
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}
