/**
 * 对话流分组单测（`apps/web/src/components/chat-grouping.ts`）。
 *
 * 验证：连续内置工具折叠为工具组、阶段工具与文本不参与折叠、组摘要统计正确。
 */
import { describe, expect, test } from "vitest";
import {
  buildChatItems,
  summarizeToolGroup,
  BUILTIN_TOOL_NAMES,
} from "../../apps/web/src/components/chat-grouping";
import type { WorkbenchMessage } from "../../apps/web/src/stores/workbench-reducer";

/** 构造一条工具卡片消息。 */
function toolMessage(id: string, tool: string): WorkbenchMessage {
  return {
    id,
    kind: "tool",
    tool: { toolCallId: id, tool, status: "done", durationMs: 1000 },
  };
}

describe("buildChatItems", () => {
  test("连续内置工具折叠为一个工具组", () => {
    const items = buildChatItems([
      toolMessage("t1", "read"),
      toolMessage("t2", "bash"),
      toolMessage("t3", "grep"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "toolGroup" });
    if (items[0]!.kind === "toolGroup") {
      expect(items[0]!.items.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
    }
  });

  test("被文本隔开的内置工具分成两组", () => {
    const items = buildChatItems([
      toolMessage("t1", "read"),
      { id: "a1", kind: "assistant", text: "继续" },
      toolMessage("t2", "bash"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["toolGroup", "message", "toolGroup"]);
  });

  test("阶段工具不参与折叠，逐条渲染", () => {
    const items = buildChatItems([
      toolMessage("t1", "copy_write"),
      toolMessage("t2", "image_generate"),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === "message")).toBe(true);
  });

  test("内置工具与阶段工具相邻时只折叠内置工具", () => {
    const items = buildChatItems([toolMessage("t1", "read"), toolMessage("t2", "scene_generate")]);
    expect(items.map((item) => item.kind)).toEqual(["toolGroup", "message"]);
  });

  test("BUILTIN_TOOL_NAMES 覆盖 Pi 内置工具", () => {
    for (const name of ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
      expect(BUILTIN_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe("summarizeToolGroup", () => {
  test("按工具名统计数量并输出中文摘要", () => {
    const summary = summarizeToolGroup([
      toolMessage("t1", "read"),
      toolMessage("t2", "read"),
      toolMessage("t3", "bash"),
    ]);
    expect(summary).toBe("读取文件 ×2 · 执行命令 ×1");
  });

  test("未知工具回退工具原名", () => {
    expect(summarizeToolGroup([toolMessage("t1", "custom_tool")])).toBe("custom_tool ×1");
  });
});
