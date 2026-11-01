import type { CapabilityStageDeclaration, Project } from "@videoforge/shared";

// ---------------------------------------------------------------------------
// 阶段指令构造（见设计文档 §6.3「阶段指令」）。
// 指令正文完全由「项目字段 + 能力声明（label / tool）」拼接得到，本模块
// **不含任何阶段专有知识**：没有按 stage 的 switch，不含各阶段专有提示词。
// 指令正文以 role=system 落库到 `messages`（`payload` 为 Pi 兼容的 SystemMessage
// 形状），使会话历史重建与 trace 回放都能看到完整脉络（设计文档 §5.2、§7.5）。
// ---------------------------------------------------------------------------

/**
 * 生成阶段指令的入参（引擎在每阶段执行前调用）。
 */
export interface StageInstructionInput {
  /** 阶段声明（来自能力注册表，含 label 与 tool）。 */
  stage: CapabilityStageDeclaration;
  /** 项目参数（topic / style / profile）。 */
  project: Pick<Project, "topic" | "style" | "profile">;
  /** 画幅 Profile（已从 project.profile 解析）。 */
  profile: string;
  /** 当前尝试序号（0 = 首次）。 */
  attempt: number;
  /** 上一次失败的错误码（仅重试时非空，用于让 agent 复述失败原因）。 */
  previousErrorCode?: string | null;
  /** 用户 retry 反馈（仅审核点重跑时非空）。 */
  feedback?: string | null;
}

/**
 * Pi 兼容的系统消息负载（形状对齐 `@earendil-works/pi-ai` 的 `SystemMessage`）。
 *
 * 核对结论（`@earendil-works/pi-ai@1.4.0` 的 `dist/types.d.ts` 第 252、346 行）：
 * `SystemMessage.content` 的实际定义为 `string | TextContent[]`，其中
 * `TextContent = { type: "text"; text: string }`。本实现采用 `TextContent[]` 这一合法分支。
 * 会话注册表把该负载原样交给 `SessionManager.appendMessage()` 重放（其内部自行生成
 * 会话条目级 `id/parentId/timestamp`，并只读取 `content`），故此处省略 `timestamp` 字段。
 */
export interface StageInstructionMessage {
  role: "system";
  content: { type: "text"; text: string }[];
}

/**
 * 判断字符串是否「有内容」（非空且去空白后非空）。
 * @param value 待判断的值（可能为 null / undefined）
 * @returns 有内容返回 `true`，否则 `false`
 */
function hasText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== "";
}

/**
 * 生成单条阶段指令正文（纯函数，便于单测）。
 *
 * 形如：
 * `执行「文案生成」阶段：调用 \`copy_generate\`。`
 * `项目上下文：topic=…；style=…；profile=…。`
 * `这是第 2 次重试（累计第 3 次尝试），上一次失败错误码：TOOL_UNAVAILABLE，请说明失败原因并修正。`
 * `用户反馈：文案再口语化一点，请据此调整。`
 * @param input 阶段指令入参
 * @returns 可直接下发 / 落库的指令正文（多行中文文本）
 */
export function buildStageInstruction(input: StageInstructionInput): string {
  const { stage, project, profile, attempt, previousErrorCode, feedback } = input;

  // 第一行：阶段展示名 + 阶段工具名，全部取自能力声明，避免本模块硬编码阶段知识
  const lines: string[] = [`执行「${stage.label}」阶段：调用 \`${stage.tool}\`。`];

  // 项目上下文：topic 恒定写入，style 为空则省略该片段，profile 恒定写入
  const context: string[] = [`topic=${project.topic}`];
  if (hasText(project.style)) {
    context.push(`style=${project.style}`);
  }
  context.push(`profile=${profile}`);
  lines.push(`项目上下文：${context.join("；")}。`);

  // 重试说明：attempt > 0 时追加；若有上一次错误码一并写出，便于 agent 复述并修正
  if (attempt > 0) {
    let retryLine = `这是第 ${attempt} 次重试（累计第 ${attempt + 1} 次尝试）`;
    if (hasText(previousErrorCode)) {
      retryLine += `，上一次失败错误码：${previousErrorCode}，请说明失败原因并修正`;
    }
    lines.push(`${retryLine}。`);
  }

  // 用户反馈：仅审核点重跑时非空，追加一段要求 agent 据此调整
  if (hasText(feedback)) {
    lines.push(`用户反馈：${feedback}，请据此调整。`);
  }

  return lines.join("\n");
}

/**
 * 生成可直接落库、且能被 Pi 会话重放的 system 消息负载。
 * @param input 阶段指令入参
 * @returns Pi 兼容的系统消息负载（`{ role: "system", content: [{ type: "text", text }] }`）
 */
export function buildStageInstructionMessage(
  input: StageInstructionInput,
): StageInstructionMessage {
  return {
    role: "system",
    content: [{ type: "text", text: buildStageInstruction(input) }],
  };
}
