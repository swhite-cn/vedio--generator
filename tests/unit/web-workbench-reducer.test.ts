/**
 * 工作台纯 reducer 单测（Web 专题 §7.2「SSE 事件 → UI 映射（唯一权威表）」）。
 *
 * 逐类事件断言落点，覆盖 §7.2 全部 10 类事件：
 * text_delta / tool_start / tool_end / turn_end / run_start / run_stage /
 * review_gate / run_end / resync / error，外加未识别事件的容错与
 * `sevenStages` / `toStageProgress` / `STAGE_ORDER` 的结构断言。
 */
import { describe, expect, test } from "vitest";
import {
  STAGE_ORDER,
  applyEvent,
  createInitialState,
  sevenStages,
  toStageProgress,
  type WorkbenchState,
} from "../../apps/web/src/stores/workbench-reducer";
import type { Project } from "../../apps/web/src/stores/projects";
import type { SseFrame } from "../../apps/web/src/services/sse";

/** 构造一帧 SSE 事件（简化断言代码）。 */
function frame(type: string, data: unknown): SseFrame {
  return { type, data };
}

/** 取对话流最后一条消息。 */
function lastMessage(state: WorkbenchState) {
  return state.messages[state.messages.length - 1];
}

describe("结构：七阶段初始状态", () => {
  test("STAGE_ORDER 为固定七阶段顺序", () => {
    expect(STAGE_ORDER).toEqual([
      "copy",
      "image",
      "scene",
      "tts",
      "storyboard",
      "render",
      "compose",
    ]);
  });

  test("sevenStages 生成 7 条 pending 阶段", () => {
    const stages = sevenStages();
    expect(stages).toHaveLength(7);
    expect(stages.every((s) => s.status === "pending" && s.attempt === 0)).toBe(true);
  });

  test("toStageProgress 恒返回 7 条并按固定顺序补齐缺失阶段", () => {
    const stages = toStageProgress([
      { stage: "copy", status: "done", attempt: 1, started_at: "t0", ended_at: "t1" },
      { stage: "image", status: "failed", attempt: 2, error_code: "ADAPTER_FAILED" },
    ]);
    expect(stages.map((s) => s.stage)).toEqual([...STAGE_ORDER]);
    expect(stages[0]).toMatchObject({ status: "done", attempt: 1 });
    expect(stages[1]).toMatchObject({ status: "failed", attempt: 2, error_code: "ADAPTER_FAILED" });
    expect(stages[2]).toMatchObject({ status: "pending", error_code: null });
  });
});

describe("text_delta", () => {
  test("首帧新建 assistant 气泡并置流式中", () => {
    const state = applyEvent(createInitialState(), frame("text_delta", { text: "你好" }));
    expect(state.messages).toHaveLength(1);
    expect(lastMessage(state)).toMatchObject({ kind: "assistant", text: "你好", streaming: true });
    expect(state.agentStreaming).toBe(true);
  });

  test("后续帧追加到同一流式气泡", () => {
    let state = applyEvent(createInitialState(), frame("text_delta", { text: "你" }));
    state = applyEvent(state, frame("text_delta", { text: "好" }));
    expect(state.messages).toHaveLength(1);
    expect(lastMessage(state).text).toBe("你好");
  });

  test("空文本不产生任何变更", () => {
    const initial = createInitialState();
    expect(applyEvent(initial, frame("text_delta", { text: "" }))).toBe(initial);
  });
});

describe("tool_start", () => {
  test("新建运行中的工具卡片并记录建卡时的阶段", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(
      state,
      frame("run_stage", { stage: "image", status: "running", attempt: 1 }),
    );
    state = applyEvent(
      state,
      frame("tool_start", { toolCallId: "t1", tool: "image_generate", args: { n: 1 } }),
    );
    const card = lastMessage(state).tool;
    expect(card).toMatchObject({
      toolCallId: "t1",
      tool: "image_generate",
      status: "running",
      stage: "image",
    });
    expect(state.agentStreaming).toBe(true);
  });

  test("携带 startedAt 时写入建卡时间（运行中卡片展示实时耗时）", () => {
    const state = applyEvent(
      createInitialState(),
      frame("tool_start", {
        toolCallId: "t1",
        tool: "scene_generate",
        startedAt: "2026-10-27T14:52:10.000Z",
      }),
    );
    expect(lastMessage(state).tool).toMatchObject({ startedAt: "2026-10-27T14:52:10.000Z" });
  });
});

describe("tool_end", () => {
  test("匹配到建卡：收尾状态与耗时", () => {
    let state = applyEvent(
      createInitialState(),
      frame("tool_start", { toolCallId: "t1", tool: "bash" }),
    );
    state = applyEvent(state, frame("tool_end", { toolCallId: "t1", ok: true, durationMs: 1200 }));
    expect(lastMessage(state).tool).toMatchObject({ status: "done", durationMs: 1200 });
  });

  test("失败结果置 failed 并记录 errorCode", () => {
    let state = applyEvent(
      createInitialState(),
      frame("tool_start", { toolCallId: "t1", tool: "bash" }),
    );
    state = applyEvent(
      state,
      frame("tool_end", { toolCallId: "t1", ok: false, errorCode: "TOOL_UNAVAILABLE" }),
    );
    expect(lastMessage(state).tool).toMatchObject({
      status: "failed",
      errorCode: "TOOL_UNAVAILABLE",
    });
  });

  test("包含 artifactPaths 时自增产物刷新令牌", () => {
    let state = applyEvent(
      createInitialState(),
      frame("tool_start", { toolCallId: "t1", tool: "bash" }),
    );
    state = applyEvent(
      state,
      frame("tool_end", { toolCallId: "t1", ok: true, artifactPaths: ["a.png"] }),
    );
    expect(state.artifactRefreshToken).toBe(1);
  });

  test("丢帧兜底：未匹配到建卡仍落一张终态卡片", () => {
    const state = applyEvent(
      createInitialState(),
      frame("tool_end", { toolCallId: "t9", ok: true }),
    );
    expect(state.messages).toHaveLength(1);
    expect(lastMessage(state).tool).toMatchObject({ toolCallId: "t9", status: "done" });
  });
});

describe("turn_end", () => {
  test("气泡定稿并解除流式态", () => {
    let state = applyEvent(createInitialState(), frame("text_delta", { text: "回答" }));
    state = applyEvent(state, frame("turn_end", {}));
    expect(lastMessage(state).streaming).toBe(false);
    expect(state.agentStreaming).toBe(false);
  });
});

describe("run_start", () => {
  test("新 run 复位阶段为全 pending 并置运行中", () => {
    const state = applyEvent(
      createInitialState(),
      frame("run_start", { runId: "r1", trigger: "auto" }),
    );
    expect(state.currentRun).toMatchObject({ id: "r1", status: "running" });
    expect(state.stages.every((s) => s.status === "pending")).toBe(true);
    expect(state.finalReady).toBe(false);
  });

  test("携带 fromStage 时其之前阶段置 skipped", () => {
    const state = applyEvent(
      createInitialState(),
      frame("run_start", { runId: "r1", fromStage: "tts" }),
    );
    expect(state.stages[0].status).toBe("skipped"); // copy
    expect(state.stages[2].status).toBe("skipped"); // scene
    expect(state.stages[3].status).toBe("pending"); // tts
  });
});

describe("run_stage", () => {
  test("更新对应阶段状态并推进 current_stage", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(state, frame("run_stage", { stage: "copy", status: "running", attempt: 1 }));
    const copy = state.stages.find((s) => s.stage === "copy");
    expect(copy).toMatchObject({ status: "running", attempt: 1 });
    expect(state.currentRun?.current_stage).toBe("copy");
  });

  test("done 且带 artifactPaths 时自增产物刷新令牌", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(
      state,
      frame("run_stage", {
        stage: "copy",
        status: "done",
        attempt: 1,
        artifactPaths: ["copy.json"],
      }),
    );
    expect(state.artifactRefreshToken).toBe(1);
  });

  test("failed 时记录 error_code", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(
      state,
      frame("run_stage", {
        stage: "render",
        status: "failed",
        attempt: 2,
        errorCode: "TOOL_UNAVAILABLE",
      }),
    );
    expect(state.stages.find((s) => s.stage === "render")?.error_code).toBe("TOOL_UNAVAILABLE");
  });

  test("running / done 事件携带起止时间时写入阶段进度（步骤条可显示实时耗时）", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(
      state,
      frame("run_stage", {
        stage: "scene",
        status: "running",
        attempt: 0,
        startedAt: "2026-10-27T14:52:10.000Z",
      }),
    );
    const running = state.stages.find((s) => s.stage === "scene");
    expect(running).toMatchObject({ started_at: "2026-10-27T14:52:10.000Z", ended_at: null });

    state = applyEvent(
      state,
      frame("run_stage", {
        stage: "scene",
        status: "done",
        attempt: 0,
        endedAt: "2026-10-27T15:02:10.000Z",
      }),
    );
    const done = state.stages.find((s) => s.stage === "scene");
    expect(done).toMatchObject({
      started_at: "2026-10-27T14:52:10.000Z",
      ended_at: "2026-10-27T15:02:10.000Z",
    });
  });
});

describe("review_gate", () => {
  test("插入审核卡片并把 run 置为待审核", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(
      state,
      frame("review_gate", { runId: "r1", stage: "copy", summary: "文案已生成" }),
    );
    expect(lastMessage(state).kind).toBe("review");
    expect(lastMessage(state).review).toMatchObject({
      runId: "r1",
      stage: "copy",
      summary: "文案已生成",
    });
    expect(state.currentRun).toMatchObject({ status: "waiting_review", current_stage: "copy" });
  });
});

describe("run_end", () => {
  test("成功：置 finalReady 并自增产物刷新令牌", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(state, frame("run_end", { runId: "r1", status: "done" }));
    expect(state.currentRun?.status).toBe("done");
    expect(state.finalReady).toBe(true);
    expect(state.artifactRefreshToken).toBe(1);
    expect(state.agentStreaming).toBe(false);
  });

  test("失败：追加系统条说明失败阶段与 errorCode", () => {
    let state = applyEvent(createInitialState(), frame("run_start", { runId: "r1" }));
    state = applyEvent(state, frame("run_stage", { stage: "scene", status: "failed", attempt: 1 }));
    state = applyEvent(
      state,
      frame("run_end", { runId: "r1", status: "failed", errorCode: "ADAPTER_FAILED" }),
    );
    expect(state.finalReady).toBe(false);
    const system = lastMessage(state);
    expect(system.kind).toBe("system");
    expect(system.text).toContain("场景");
    expect(system.text).toContain("ADAPTER_FAILED");
  });
});

describe("resync", () => {
  test("清空 run/阶段/产物/消息缓存，保留项目与会话并置 needsResync", () => {
    const project = { id: "p1" } as unknown as Project;
    const base: WorkbenchState = {
      ...createInitialState(),
      project,
      session: { id: "s1", project_id: "p1", title: "会话", created_at: "", updated_at: "" },
    };
    let state = applyEvent(base, frame("text_delta", { text: "hi" }));
    state = applyEvent(state, frame("resync", { reason: "buffer-miss" }));
    expect(state.project).toBe(project);
    expect(state.session?.id).toBe("s1");
    expect(state.messages).toEqual([]);
    expect(state.currentRun).toBeNull();
    expect(state.artifacts).toBeNull();
    expect(state.needsResync).toBe(true);
    expect(state.stages).toHaveLength(7);
  });
});

describe("error 与未知事件", () => {
  test("error 记录 lastError 载荷", () => {
    const state = applyEvent(
      createInitialState(),
      frame("error", { code: "TOOL_UNAVAILABLE", message: "工具不可用" }),
    );
    expect(state.lastError).toEqual({ code: "TOOL_UNAVAILABLE", message: "工具不可用" });
  });

  test("error 缺字段时回落默认值", () => {
    const state = applyEvent(createInitialState(), frame("error", {}));
    expect(state.lastError).toEqual({ code: "UNKNOWN", message: "未知错误" });
  });

  test("未识别事件原样返回同一状态", () => {
    const initial = createInitialState();
    expect(applyEvent(initial, frame("totally_unknown", { x: 1 }))).toBe(initial);
  });
});
