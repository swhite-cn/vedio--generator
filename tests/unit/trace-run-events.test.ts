/**
 * Trace「事件」时间线合成单测（`apps/server/src/trace/run-events.ts`）。
 *
 * 验证：run / 阶段 / 工具 / LLM 留痕被合成为按时间升序的事件；
 * 工具与 LLM 调用通过 `stage_id` 映射回阶段名；失败与跳过事件类型正确。
 */
import { describe, expect, test } from "vitest";
import type { LlmCall, Run, RunStage, ToolCall } from "@videoforge/shared";
import { buildRunEvents } from "../../apps/server/src/trace/run-events";

/** 构造一条 run（默认成功结束）。 */
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    project_id: "p1",
    session_id: "s1",
    status: "done",
    trigger: "user",
    current_stage: "compose",
    error_code: null,
    created_at: "2026-10-27T10:00:00.000Z",
    started_at: "2026-10-27T10:00:01.000Z",
    ended_at: "2026-10-27T10:10:00.000Z",
    ...overrides,
  };
}

/** 构造一条阶段实例。 */
function makeStage(overrides: Partial<RunStage> = {}): RunStage {
  return {
    id: "st1",
    run_id: "r1",
    stage: "copy",
    status: "done",
    attempt: 1,
    error_code: null,
    artifact_paths: [],
    started_at: "2026-10-27T10:00:02.000Z",
    ended_at: "2026-10-27T10:01:00.000Z",
    ...overrides,
  };
}

/** 构造一条工具调用留痕。 */
function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc1",
    session_id: "s1",
    run_id: "r1",
    stage_id: "st1",
    tool: "copy_write",
    args_json: {},
    ok: true,
    error_code: null,
    duration_ms: 1200,
    artifact_paths: [],
    created_at: "2026-10-27T10:00:30.000Z",
    ...overrides,
  };
}

/** 构造一条 LLM 调用留痕。 */
function makeLlmCall(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    id: "lc1",
    session_id: "s1",
    run_id: "r1",
    stage_id: "st1",
    model: "doubao-pro",
    request_json: {},
    response_json: {},
    prompt_tokens: 100,
    completion_tokens: 50,
    duration_ms: 900,
    ok: true,
    error_code: null,
    created_at: "2026-10-27T10:00:20.000Z",
    ...overrides,
  };
}

describe("buildRunEvents", () => {
  test("run 开始 / 结束事件来自 run 的起止时间", () => {
    const events = buildRunEvents(makeRun(), [], [], []);
    expect(events.map((item) => item.type)).toEqual(["run_started", "run_done"]);
    expect(events[0]).toMatchObject({ at: "2026-10-27T10:00:01.000Z" });
  });

  test("run 失败时产出 run_failed 并带错误码", () => {
    const events = buildRunEvents(
      makeRun({ status: "failed", error_code: "ADAPTER_FAILED" }),
      [],
      [],
      [],
    );
    const failed = events.find((item) => item.type === "run_failed");
    expect(failed).toMatchObject({ detail: "ADAPTER_FAILED" });
  });

  test("阶段起止事件与 skipped / failed 类型", () => {
    const events = buildRunEvents(
      makeRun(),
      [
        makeStage({ id: "st1", stage: "copy", status: "done" }),
        makeStage({
          id: "st2",
          stage: "image",
          status: "failed",
          error_code: "TOOL_UNAVAILABLE",
          started_at: "2026-10-27T10:02:00.000Z",
          ended_at: "2026-10-27T10:03:00.000Z",
        }),
        makeStage({
          id: "st3",
          stage: "tts",
          status: "skipped",
          started_at: null,
          ended_at: "2026-10-27T10:04:00.000Z",
        }),
      ],
      [],
      [],
    );
    const types = events.map((item) => item.type);
    expect(types).toContain("stage_started");
    expect(types).toContain("stage_done");
    expect(types).toContain("stage_failed");
    expect(types).toContain("stage_skipped");
    // 无 started_at 的阶段不产「开始」事件
    expect(events.filter((item) => item.type === "stage_started")).toHaveLength(2);
  });

  test("工具与 LLM 调用按 stage_id 映射为阶段名", () => {
    const events = buildRunEvents(
      makeRun(),
      [makeStage({ id: "st1", stage: "image" })],
      [makeToolCall({ stage_id: "st1" })],
      [makeLlmCall({ stage_id: "st1" })],
    );
    const tool = events.find((item) => item.type === "tool_call");
    const llm = events.find((item) => item.type === "llm_call");
    expect(tool?.stage).toBe("image");
    expect(llm?.stage).toBe("image");
    expect(llm?.detail).toContain("150 tokens");
  });

  test("事件按时间升序排列", () => {
    const events = buildRunEvents(makeRun(), [makeStage()], [makeToolCall()], [makeLlmCall()]);
    const times = events.map((item) => item.at);
    expect([...times].sort()).toEqual(times);
  });
});
