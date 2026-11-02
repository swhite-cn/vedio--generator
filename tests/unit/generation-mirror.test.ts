import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appendGenerationRecord } from "../../packages/pipeline/src/manifest";
import { mirrorGenerationRecords } from "../../apps/server/src/trace/generation-mirror";
import type { TraceLlmCallInput, TraceStore } from "../../apps/server/src/trace/trace-store";

let projectDir: string;
let calls: TraceLlmCallInput[];
let trace: TraceStore;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-mirror-"));
  calls = [];
  trace = {
    recordToolCall: vi.fn() as unknown as TraceStore["recordToolCall"],
    recordStage: vi.fn() as unknown as TraceStore["recordStage"],
    recordLlmCall: ((input: TraceLlmCallInput) => {
      calls.push(input);
      return input as never;
    }) as TraceStore["recordLlmCall"],
  };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("生成清单镜像到 llm_calls", () => {
  test("只镜像本次执行新增的同阶段记录", async () => {
    appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s0",
      prompt: "上一次的提示词",
      ok: true,
    });
    // 用真实时间间隔把"上一批记录"和"本次记录"分开，避免同毫秒内误判
    await new Promise((resolve) => setTimeout(resolve, 5));
    const startedAtIso = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      model: "image-model",
      prompt: "本次提示词",
      ok: true,
      durationMs: 120,
    });
    appendGenerationRecord(projectDir, {
      stage: "scene",
      sceneId: "s1",
      prompt: "场景提示词",
      ok: true,
    });

    mirrorGenerationRecords(
      { trace, sessionId: "sess-1", runId: "run-1", stageId: "stage-1", projectDir },
      "image_generate",
      startedAtIso,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "sess-1",
      runId: "run-1",
      stageId: "stage-1",
      model: "image-model",
      ok: true,
      durationMs: 120,
    });
    expect((calls[0].request as { prompt: string }).prompt).toBe("本次提示词");
  });

  test("降级场景记为失败调用，并保留错误码与资产路径", () => {
    const startedAtIso = new Date(Date.now() - 1000).toISOString();
    appendGenerationRecord(projectDir, {
      stage: "scene",
      sceneId: "s2",
      assetPath: "scenes/s2.html",
      prompt: "场景提示词",
      ok: true,
      fallback: true,
      errorCode: "ADAPTER_PROTOCOL_INVALID",
    });

    mirrorGenerationRecords(
      { trace, sessionId: "sess-1", projectDir },
      "scene_generate",
      startedAtIso,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].errorCode).toBe("ADAPTER_PROTOCOL_INVALID");
    expect((calls[0].response as { assetPath: string }).assetPath).toBe("scenes/s2.html");
  });

  test("非生成类阶段工具不产生镜像", () => {
    appendGenerationRecord(projectDir, { stage: "image", sceneId: "s1", ok: true });
    mirrorGenerationRecords(
      { trace, sessionId: "sess-1", projectDir },
      "render_frames",
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(calls).toHaveLength(0);
  });
});
