import type { ToolCardData, WorkbenchMessage } from "./workbench-reducer";

/**
 * 历史消息映射（服务端 `messages` 表 → 对话流视图模型）。
 *
 * 数据库按 Pi 原生消息落库：assistant 的 `content` 为块数组（text / thinking / toolCall），
 * toolResult 为独立消息（`toolCallId` 关联）。本模块把两者合并为气泡、思考块与工具卡片，
 * 保证刷新页面后对话可完整回放。
 */

/** 服务端消息行（`GET /api/sessions/:id/messages`）。 */
export interface ServerMessage {
  id: string;
  session_id: string;
  run_id?: string;
  role: string;
  payload: unknown;
  created_at: string;
  asset_refs?: Array<{
    asset_id?: string;
    asset?: { id: string; label: string; kind: string; mime_type?: string; size_bytes?: number };
  }>;
}

/** Pi 内容块（只声明用到的字段）。 */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** 从消息负载中取内容块数组。 */
function contentBlocks(payload: unknown): ContentBlock[] {
  if (!payload || typeof payload !== "object") return [];
  const content = (payload as { content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content as ContentBlock[];
}

/** 取文本块拼接。 */
function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** 截断历史工具输出（与服务端 8KB 预览对齐）。 */
function previewText(text: string, limit = 8192): { preview: string; truncated: boolean } {
  if (text.length <= limit) return { preview: text, truncated: false };
  return { preview: text.slice(0, limit), truncated: true };
}

/**
 * 将历史消息映射为对话流消息。
 * @param messages 服务端消息（按创建时间升序）
 * @returns 对话流消息列表
 */
export function mapHistoryMessages(messages: ServerMessage[]): WorkbenchMessage[] {
  const output: WorkbenchMessage[] = [];
  const toolCards = new Map<string, ToolCardData>();

  for (const message of messages) {
    const blocks = contentBlocks(message.payload);
    const at = message.created_at;

    if (message.role === "user") {
      const text = textOf(blocks);
      if (text) {
        output.push({
          id: message.id,
          kind: "user",
          text,
          at,
          assetRefs: (message.asset_refs ?? []).flatMap((ref) =>
            ref.asset
              ? [
                  {
                    id: ref.asset.id,
                    label: ref.asset.label,
                    kind: ref.asset.kind,
                    mime_type: ref.asset.mime_type,
                    size_bytes: ref.asset.size_bytes,
                  },
                ]
              : [],
          ),
        });
      }
      continue;
    }

    if (message.role === "system") {
      const text = textOf(blocks);
      if (text) {
        output.push({ id: message.id, kind: "system", text, at });
      }
      continue;
    }

    if (message.role === "assistant") {
      const thinking = blocks
        .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking as string)
        .join("");
      if (thinking) {
        output.push({ id: `${message.id}-thinking`, kind: "thinking", text: thinking, at });
      }

      const text = textOf(blocks);
      if (text) {
        output.push({ id: message.id, kind: "assistant", text, at });
      }

      for (const block of blocks) {
        if (block.type !== "toolCall" || !block.id) continue;
        const card: ToolCardData = {
          toolCallId: block.id,
          tool: block.name ?? "",
          args: block.arguments,
          status: "running",
          stage: null,
        };
        toolCards.set(block.id, card);
        output.push({
          id: `tool-${block.id}`,
          kind: "tool",
          tool: card,
          at,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      const payload = (message.payload ?? {}) as { toolCallId?: unknown; isError?: unknown };
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const card = toolCallId ? toolCards.get(toolCallId) : undefined;
      if (!card) continue;
      const { preview, truncated } = previewText(textOf(blocks));
      const failed = payload.isError === true;
      card.status = failed ? "failed" : "done";
      card.outputPreview = preview || null;
      card.outputTruncated = truncated;
      card.errorCode = failed ? "TOOL_UNAVAILABLE" : null;
    }
  }

  return output;
}
