/**
 * 历史消息映射单测（`apps/web/src/stores/history-messages.ts`）。
 *
 * 覆盖：user / system / assistant 文本、思考块、toolCall 卡片，以及 toolResult 回填输出与状态。
 */
import { describe, expect, test } from "vitest";
import { mapHistoryMessages, type ServerMessage } from "../../apps/web/src/stores/history-messages";

/**
 * 构造一条服务端消息。
 * @param id 消息 id
 * @param role 角色
 * @param payload 负载
 * @returns 消息行
 */
function message(id: string, role: string, payload: unknown): ServerMessage {
  return {
    id,
    session_id: "s1",
    role,
    payload,
    created_at: "2026-10-27T10:00:00.000Z",
  };
}

describe("mapHistoryMessages", () => {
  test("user 与 system 映射为对应气泡", () => {
    const items = mapHistoryMessages([
      message("m1", "user", { role: "user", content: [{ type: "text", text: "你好" }] }),
      message("m2", "system", { role: "system", content: "引擎指令" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "你好" });
    expect(items[1]).toMatchObject({ kind: "system", text: "引擎指令" });
  });

  test("assistant 的思考块与正文拆成两条消息", () => {
    const items = mapHistoryMessages([
      message("m1", "assistant", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先分析" },
          { type: "text", text: "正文" },
        ],
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["thinking", "assistant"]);
    expect(items[0]?.text).toBe("先分析");
    expect(items[1]?.text).toBe("正文");
  });

  test("toolCall 块生成工具卡片，toolResult 回填输出与状态", () => {
    const items = mapHistoryMessages([
      message("m1", "assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      }),
      message("m2", "tool", {
        role: "tool",
        toolCallId: "call-1",
        content: [{ type: "text", text: "a.txt" }],
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.tool).toMatchObject({
      toolCallId: "call-1",
      tool: "bash",
      status: "done",
      outputPreview: "a.txt",
      outputTruncated: false,
    });
  });

  test("toolResult 标记 isError 时卡片置 failed", () => {
    const items = mapHistoryMessages([
      message("m1", "assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      }),
      message("m2", "tool", {
        role: "tool",
        toolCallId: "call-1",
        isError: true,
        content: [{ type: "text", text: "文件不存在" }],
      }),
    ]);
    expect(items[0]?.tool).toMatchObject({
      status: "failed",
      errorCode: "TOOL_UNAVAILABLE",
      outputPreview: "文件不存在",
    });
  });

  test("超长输出按 8KB 截断并标记", () => {
    const items = mapHistoryMessages([
      message("m1", "assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
      }),
      message("m2", "tool", {
        role: "tool",
        toolCallId: "call-1",
        content: [{ type: "text", text: "x".repeat(9000) }],
      }),
    ]);
    expect(items[0]?.tool?.outputPreview).toHaveLength(8192);
    expect(items[0]?.tool?.outputTruncated).toBe(true);
  });

  test("孤立 toolResult（无对应 toolCall）被忽略", () => {
    const items = mapHistoryMessages([
      message("m1", "tool", { role: "tool", toolCallId: "ghost", content: "x" }),
    ]);
    expect(items).toEqual([]);
  });
});
