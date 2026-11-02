import type { WorkbenchMessage } from "../stores/workbench-reducer";

/**
 * 对话流渲染分组（参考 Claude Code）：
 * 同一轮内连续的内置工具调用（read / bash / grep…）合并为一个可折叠「工具组」，
 * 阶段工具、文本、思考块、审核卡与阶段分隔条各自独立展示。
 */

/** 内置工具名集合（阶段工具之外的 Pi 内置工具）。 */
export const BUILTIN_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
]);

/** 渲染项：单条消息或工具组。 */
export type ChatItem =
  | { kind: "message"; key: string; message: WorkbenchMessage }
  | { kind: "toolGroup"; key: string; items: WorkbenchMessage[] };

/**
 * 把消息列表折叠为渲染项列表（纯函数，便于测试）。
 * @param messages 对话消息（按时间升序）
 * @returns 渲染项列表
 */
export function buildChatItems(messages: WorkbenchMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    const isBuiltinTool =
      message.kind === "tool" && message.tool && BUILTIN_TOOL_NAMES.has(message.tool.tool);
    const last = items[items.length - 1];
    if (isBuiltinTool && last && last.kind === "toolGroup") {
      last.items.push(message);
      continue;
    }
    if (isBuiltinTool) {
      items.push({ kind: "toolGroup", key: `group-${message.id}`, items: [message] });
      continue;
    }
    items.push({ kind: "message", key: message.id, message });
  }
  return items;
}

/**
 * 工具组摘要：`读取文件 ×3 · 执行命令 ×1`。
 * @param items 工具卡片消息列表
 * @returns 摘要文本
 */
export function summarizeToolGroup(items: WorkbenchMessage[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const tool = item.tool?.tool ?? "";
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tool, count]) => `${toolLabel(tool)} ×${count}`).join(" · ");
}

/** 工具中文名（与 state-mapping 保持一致，避免组件层重复依赖）。 */
function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    grep: "内容检索",
    find: "查找文件",
    ls: "列出目录",
    bash: "执行命令",
    powershell: "执行命令",
  };
  return labels[tool] ?? tool;
}
