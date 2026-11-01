/**
 * 状态映射纯函数（Web 专题 §2.3「状态色映射（唯一权威表）」）。
 *
 * 全站状态一律经此模块转换为 Tag/Steps 的文案与颜色，不在组件内另写映射。
 * 抽出为纯函数便于单元测试覆盖三张映射表。
 */

/** 允许的 Tag 颜色（Ant Design Vue 预设语义色）。 */
export type TagColor = "default" | "processing" | "warning" | "success" | "error";

/** 允许的步骤条状态。 */
export type StepStatus = "wait" | "process" | "finish" | "error";

/** 状态映射结果（Tag 渲染用）。 */
export interface StatusMeta {
  /** 中文文案。 */
  text: string;
  /** Tag 颜色。 */
  color: TagColor;
}

/** 阶段状态映射结果（Tag + 步骤条两用）。 */
export interface StageStatusMeta extends StatusMeta {
  /** 步骤条状态表现。 */
  stepStatus: StepStatus;
}

/** `running`/`canceled` 相关的固定 Tooltip 文案。 */
export const INTERRUPTED_TOOLTIP = "服务重启导致中断，可续跑";
/** `skipped` 阶段的固定 Tooltip 文案。 */
export const SKIPPED_TOOLTIP = "产物已存在，本次跳过";

/** 七阶段中文名（Web 专题 §2.3 固定命名）。 */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  copy: "文案",
  image: "配图",
  scene: "场景",
  tts: "配音",
  storyboard: "时间轴",
  render: "渲染",
  compose: "合成",
};

/** 工具中文名映射（Web 专题 §5.4.2 工具调用卡片头部）。覆盖七个阶段工具与内置工具。 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  // 阶段工具（与 `apps/server/src/workflow/capabilities.ts` 的 STAGE_TOOL_AND_LABEL 一致）
  copy_generate: "文案生成",
  image_generate: "配图生成",
  scene_generate: "场景生成",
  tts_generate: "语音合成",
  storyboard_generate: "时间轴生成",
  render_frames: "逐帧渲染",
  compose_video: "视频合成",
  // 内置工具
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "内容检索",
  bash: "执行命令",
};

/**
 * 取工具中文名。
 * @param tool 工具标识
 * @returns 中文名；未命中时回退原工具标识
 */
export function toolDisplayName(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** 项目状态映射表（主文档 §11 `projects.status`）。 */
const PROJECT_STATUS_MAP: Readonly<Record<string, StatusMeta>> = {
  draft: { text: "草稿", color: "default" },
  running: { text: "运行中", color: "processing" },
  review: { text: "待审核", color: "warning" },
  done: { text: "已完成", color: "success" },
  failed: { text: "失败", color: "error" },
};

/** run 状态映射表（主文档 §6.2）。`canceled` 文案随 `errorCode` 变化，故单列处理。 */
const RUN_STATUS_MAP: Readonly<Record<string, StatusMeta>> = {
  queued: { text: "排队中", color: "default" },
  running: { text: "运行中", color: "processing" },
  waiting_review: { text: "待审核", color: "warning" },
  done: { text: "已完成", color: "success" },
  failed: { text: "失败", color: "error" },
};

/** 阶段状态映射表（`run_stages.status`）。 */
const STAGE_STATUS_MAP: Readonly<Record<string, StageStatusMeta>> = {
  pending: { text: "待执行", color: "default", stepStatus: "wait" },
  running: { text: "运行中", color: "processing", stepStatus: "process" },
  done: { text: "已完成", color: "success", stepStatus: "finish" },
  failed: { text: "失败", color: "error", stepStatus: "error" },
  skipped: { text: "已跳过", color: "default", stepStatus: "finish" },
};

/**
 * 映射项目状态。
 * @param status 服务端项目状态
 * @returns 文案与颜色；未知状态回退灰底原样文案
 */
export function mapProjectStatus(status: string): StatusMeta {
  return PROJECT_STATUS_MAP[status] ?? { text: status, color: "default" };
}

/**
 * 映射 run 状态。
 * `canceled` 且 `errorCode === "INTERRUPTED"` 时文案为「已中断」，否则「已取消」。
 * @param status 服务端 run 状态
 * @param errorCode run 错误码（可选）
 * @returns 文案与颜色
 */
export function mapRunStatus(status: string, errorCode?: string | null): StatusMeta {
  if (status === "canceled") {
    return { text: errorCode === "INTERRUPTED" ? "已中断" : "已取消", color: "default" };
  }
  return RUN_STATUS_MAP[status] ?? { text: status, color: "default" };
}

/**
 * 映射阶段状态。
 * @param status 服务端阶段状态
 * @returns 文案、Tag 颜色与步骤条状态；未知状态回退灰底原样文案
 */
export function mapStageStatus(status: string): StageStatusMeta {
  return STAGE_STATUS_MAP[status] ?? { text: status, color: "default", stepStatus: "wait" };
}

/**
 * 计算某状态所需的 Tooltip 文案（无则为空串）。
 * @param type 状态类别
 * @param status 状态值
 * @param errorCode run 错误码（可选）
 * @returns Tooltip 文案；无需提示时为空串
 */
export function statusTooltip(
  type: "project" | "run" | "stage",
  status: string,
  errorCode?: string | null,
): string {
  if (type === "run" && status === "canceled" && errorCode === "INTERRUPTED") {
    return INTERRUPTED_TOOLTIP;
  }
  if (type === "stage" && status === "skipped") {
    return SKIPPED_TOOLTIP;
  }
  return "";
}
