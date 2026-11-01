/**
 * SSE 客户端纯函数单测（Web 专题 §5.4.5、主文档 §4.4）。
 *
 * 覆盖 SSE 帧解析（命名事件、id、注释行、多行 data、非法 JSON、空帧）
 * 与断线计数阈值（连续 3 次失败才通知 UI 断线）。
 */
import { describe, expect, test } from "vitest";
import {
  SSE_DISCONNECT_THRESHOLD,
  parseSseFrame,
  shouldNotifyDisconnected,
} from "../../apps/web/src/services/sse";

describe("parseSseFrame", () => {
  test("parses a named event frame into type + parsed JSON data", () => {
    const frame = parseSseFrame('event: run_stage\ndata: {"stage":"copy","status":"running"}');
    expect(frame).toEqual({
      type: "run_stage",
      data: { stage: "copy", status: "running" },
    });
  });

  test("keeps the id when the server sends one", () => {
    const frame = parseSseFrame('id: 42\nevent: tool_end\ndata: {"tool":"bash"}');
    expect(frame).toEqual({ id: "42", type: "tool_end", data: { tool: "bash" } });
  });

  test("defaults the type to message for a data-only frame", () => {
    const frame = parseSseFrame('data: {"hello":true}');
    expect(frame).toEqual({ type: "message", data: { hello: true } });
  });

  test("ignores comment lines and blank lines", () => {
    const frame = parseSseFrame(': keep-alive\ndata: {"n":1}');
    expect(frame).toEqual({ type: "message", data: { n: 1 } });
  });

  test("joins multi-line data before parsing", () => {
    // 两段 data 以 \n 拼接；拼接结果不是合法 JSON，故按原文字符串返回并保留换行
    const frame = parseSseFrame("data: hel\ndata: lo");
    expect(frame).toEqual({ type: "message", data: "hel\nlo" });
  });

  test("returns the raw string when data is not valid JSON", () => {
    const frame = parseSseFrame("event: text_delta\ndata: 你好");
    expect(frame).toEqual({ type: "text_delta", data: "你好" });
  });

  test("returns null for a frame without event and data", () => {
    expect(parseSseFrame("")).toBeNull();
    expect(parseSseFrame(": comment only")).toBeNull();
  });

  test("tolerates CRLF line endings", () => {
    const frame = parseSseFrame('event: run_start\r\ndata: {"fromStage":"copy"}');
    expect(frame).toEqual({ type: "run_start", data: { fromStage: "copy" } });
  });
});

describe("shouldNotifyDisconnected", () => {
  test("keeps the threshold at three consecutive failures", () => {
    expect(SSE_DISCONNECT_THRESHOLD).toBe(3);
  });

  test("does not notify below the threshold", () => {
    expect(shouldNotifyDisconnected(0)).toBe(false);
    expect(shouldNotifyDisconnected(1)).toBe(false);
    expect(shouldNotifyDisconnected(2)).toBe(false);
  });

  test("notifies at or above the threshold", () => {
    expect(shouldNotifyDisconnected(3)).toBe(true);
    expect(shouldNotifyDisconnected(4)).toBe(true);
  });
});
