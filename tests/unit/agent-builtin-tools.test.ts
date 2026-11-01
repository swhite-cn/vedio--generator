import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateCopy } from "@videoforge/pipeline";
import type { TraceStore } from "../../apps/server/src/trace/trace-store";
import {
  BUILTIN_TOOL_NAMES_READONLY,
  BUILTIN_TOOL_NAMES_WRITE,
  createBuiltinTools,
} from "../../apps/server/src/agent/tools/builtin-tools";
import { createAgentTools } from "../../apps/server/src/agent/tools/index";
import { withToolTrace } from "../../apps/server/src/agent/tools/tool-trace";

// 组合测试会触达阶段工具，内核全部 mock（与 agent-stage-tools.test.ts 同款手法），
// 避免真实 @videoforge/pipeline / renderer 在模块加载期引入重依赖。
vi.mock("@videoforge/pipeline", () => ({
  generateCopy: vi.fn(),
  generateImages: vi.fn(),
  generateScenes: vi.fn(),
  generateSpeech: vi.fn(),
  generateStoryboard: vi.fn(),
  composeVideoStep: vi.fn(),
}));
vi.mock("@videoforge/renderer", () => ({ renderFrames: vi.fn() }));

/** 阶段工具的 7 个名字（与 stage-tools 的阶段顺序一致）。 */
const STAGE_TOOL_NAMES = [
  "copy_generate",
  "image_generate",
  "scene_generate",
  "tts_generate",
  "storyboard_generate",
  "render_frames",
  "compose_video",
];

let projectDir: string;
let rootDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-builtin-project-"));
  rootDir = mkdtempSync(join(tmpdir(), "videoforge-builtin-root-"));
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

/** 构造一个仅用于测试 `withToolTrace` 的假 ToolDefinition（不触碰真实磁盘/内核）。 */
function fakeDefinition(
  name: string,
  execute: (params: any) => Promise<any>,
): ToolDefinition<any, any> {
  return {
    name,
    label: name,
    description: "",
    parameters: {} as any,
    execute: (_toolCallId: string, params: any) => execute(params),
  } as unknown as ToolDefinition<any, any>;
}

/** 构造一个记录调用的假 TraceStore。 */
function createMockTrace() {
  const recordToolCall = vi.fn().mockReturnValue({});
  const trace = {
    recordToolCall,
    recordLlmCall: vi.fn(),
    recordStage: vi.fn(),
  } as unknown as TraceStore;
  return { trace, recordToolCall };
}

describe("内置工具集：工具集差异（allow_shell_write_edit）", () => {
  test("allowShellWriteEdit=true → 只读四件套 + bash/write/edit，顺序稳定", () => {
    const tools = createBuiltinTools({ projectDir, allowShellWriteEdit: true, sessionId: "s1" });
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "write",
      "edit",
    ]);
  });

  test("allowShellWriteEdit=false → 仅只读四件套，不含 bash/write/edit", () => {
    const tools = createBuiltinTools({ projectDir, allowShellWriteEdit: false, sessionId: "s1" });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["read", "grep", "find", "ls"]);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
  });

  test("每个内置工具都具备 name/label/parameters（不触碰真实文件系统）", () => {
    const tools = createBuiltinTools({ projectDir, allowShellWriteEdit: true, sessionId: "s1" });
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.label).toBe("string");
      expect(tool.parameters).toBeDefined();
    }
  });

  test("导出的只读/写工具名常量与实现一致", () => {
    expect([...BUILTIN_TOOL_NAMES_READONLY]).toEqual(["read", "grep", "find", "ls"]);
    expect([...BUILTIN_TOOL_NAMES_WRITE]).toEqual(["bash", "write", "edit"]);
  });
});

describe("withToolTrace：留痕与 args 裁剪", () => {
  test("成功执行：记一条 tool_calls，字段正确且 artifactPaths 为空数组", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const tool = withToolTrace(
      fakeDefinition("read", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: undefined,
        structuredContent: { exit_code: 0 },
      })),
      { trace, sessionId: "s1", runId: "r1", stageId: "st1", projectDir },
    );

    const result = await tool.execute(
      "call-1",
      { path: "a.txt" } as any,
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(recordToolCall).toHaveBeenCalledTimes(1);
    const input = recordToolCall.mock.calls[0][0];
    expect(input.tool).toBe("read");
    expect(input.sessionId).toBe("s1");
    expect(input.runId).toBe("r1");
    expect(input.stageId).toBe("st1");
    expect(input.ok).toBe(true);
    expect(input.errorCode).toBeNull();
    expect(typeof input.durationMs).toBe("number");
    expect(input.artifactPaths).toEqual([]);
    // 非 write/edit/bash：args 原样记录整个 params
    expect(input.args).toEqual({ path: "a.txt" });
  });

  test("runId / stageId 传函数时，按调用时的最新值留痕（阶段上下文可动态切换）", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const context: { runId: string | null; stageId: string | null } = {
      runId: null,
      stageId: null,
    };
    const tool = withToolTrace(
      fakeDefinition("read", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: undefined,
      })),
      {
        trace,
        sessionId: "s1",
        runId: () => context.runId,
        stageId: () => context.stageId,
        projectDir,
      },
    );

    // 会话创建期上下文为空
    await tool.execute("call-a", { path: "a.txt" } as any, undefined, undefined, undefined as any);
    expect(recordToolCall.mock.calls[0][0].runId).toBeNull();
    expect(recordToolCall.mock.calls[0][0].stageId).toBeNull();

    // 引擎进入阶段后同一工具读取到最新的 run / 阶段
    context.runId = "r-2";
    context.stageId = "stage-2";
    await tool.execute("call-b", { path: "b.txt" } as any, undefined, undefined, undefined as any);
    expect(recordToolCall.mock.calls[1][0].runId).toBe("r-2");
    expect(recordToolCall.mock.calls[1][0].stageId).toBe("stage-2");
  });

  test("write 工具：args 只保留相对项目目录的路径，绝不记录正文", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const tool = withToolTrace(
      fakeDefinition("write", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: undefined,
      })),
      { trace, sessionId: "s1", projectDir },
    );

    await tool.execute(
      "call-2",
      { path: join(projectDir, "a.txt"), content: "SECRET_BODY" } as any,
      undefined,
      undefined,
      undefined as any,
    );

    const args = recordToolCall.mock.calls[0][0].args as Record<string, unknown>;
    expect(args).toEqual({ path: "a.txt" });
    expect(JSON.stringify(args)).not.toContain("SECRET_BODY");
  });

  test("edit 工具：args 只保留相对路径，剔除 edits 正文", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const tool = withToolTrace(
      fakeDefinition("edit", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: undefined,
      })),
      { trace, sessionId: "s1", projectDir },
    );

    await tool.execute(
      "call-3",
      {
        path: join(projectDir, "sub", "b.txt"),
        edits: [{ oldText: "SECRET_OLD", newText: "new" }],
      } as any,
      undefined,
      undefined,
      undefined as any,
    );

    const args = recordToolCall.mock.calls[0][0].args as Record<string, unknown>;
    expect(args).toEqual({ path: "sub/b.txt" });
    expect(JSON.stringify(args)).not.toContain("SECRET_OLD");
  });

  test("bash 工具：args 记录命令原文并补记 exit_code", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const tool = withToolTrace(
      fakeDefinition("bash", async () => ({
        content: [{ type: "text", text: "done" }],
        details: undefined,
        structuredContent: { exit_code: 2 },
      })),
      { trace, sessionId: "s1", projectDir },
    );

    await tool.execute(
      "call-4",
      { command: "ffprobe -v error out.mp3", timeout: 5000 } as any,
      undefined,
      undefined,
      undefined as any,
    );

    const args = recordToolCall.mock.calls[0][0].args as Record<string, unknown>;
    expect(args).toEqual({ command: "ffprobe -v error out.mp3", timeout: 5000, exit_code: 2 });
  });

  test("execute 抛错：先记 ok:false 再原样向上抛（异常不吞）", async () => {
    const { trace, recordToolCall } = createMockTrace();
    const tool = withToolTrace(
      fakeDefinition("bash", async () => {
        throw new Error("boom");
      }),
      { trace, sessionId: "s1", projectDir },
    );

    await expect(
      tool.execute("call-5", { command: "false" } as any, undefined, undefined, undefined as any),
    ).rejects.toThrow("boom");

    expect(recordToolCall).toHaveBeenCalledTimes(1);
    const input = recordToolCall.mock.calls[0][0];
    expect(input.tool).toBe("bash");
    expect(input.ok).toBe(false);
    expect(input.errorCode).toBe("TOOL_UNAVAILABLE");
  });

  test("trace 缺省：返回原定义，行为与不加包装完全一致", async () => {
    const fake = fakeDefinition("read", async () => ({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    }));
    const wrapped = withToolTrace(fake, { sessionId: "s1" });

    expect(wrapped).toBe(fake);
    const result = await wrapped.execute(
      "call-6",
      {} as any,
      undefined,
      undefined,
      undefined as any,
    );
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("createAgentTools：阶段工具 + 内置工具组合与留痕接线", () => {
  /** 构造一份最小的组合上下文（内核实现在测试中被 mock）。 */
  function composition(overrides: { trace?: TraceStore } = {}) {
    return {
      stage: {
        rootDir,
        projectDir,
        profile: "LANDSCAPE_1080P" as const,
        style: "科普",
        runId: "run-1",
        config: { runtime: { max_concurrent_stage: 1 } } as any,
      },
      builtin: {
        projectDir,
        allowShellWriteEdit: true,
        sessionId: "s1",
        runId: "run-1",
        stageId: "st1",
        ...overrides,
      } as any,
    };
  }

  test("返回 7 个阶段工具 + 内置工具，且名字集合不因是否留痕而改变", () => {
    const withoutTrace = createAgentTools(composition()).map((tool) => tool.name);
    const { trace } = createMockTrace();
    const withTrace = createAgentTools(composition({ trace })).map((tool) => tool.name);

    const expected = [...STAGE_TOOL_NAMES, "read", "grep", "find", "ls", "bash", "write", "edit"];
    expect(withoutTrace).toEqual(expected);
    expect(withTrace).toEqual(expected);
  });

  test("trace 缺省时，阶段工具未被包装（与 createStageTools 名字一致）", () => {
    const tools = createAgentTools(composition());
    // 未包装时就是 stage-tools 的原始对象：execute 由 stage-tools 直接提供
    expect(tools.map((tool) => tool.name).slice(0, 7)).toEqual(STAGE_TOOL_NAMES);
  });

  test("trace 存在时，阶段工具也被留痕包装（调用 copy_generate 会落 tool_calls）", async () => {
    const { trace, recordToolCall } = createMockTrace();
    vi.mocked(generateCopy).mockResolvedValue({
      out: join(projectDir, "copy.json"),
      sceneCount: 3,
    } as any);
    const tools = createAgentTools(composition({ trace }));
    const copyTool = tools.find((tool) => tool.name === "copy_generate");
    expect(copyTool).toBeDefined();

    const result = await copyTool!.execute(
      "call-7",
      { topic: "黑洞" } as any,
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.isError).toBeUndefined();
    expect(recordToolCall).toHaveBeenCalledTimes(1);
    expect(recordToolCall.mock.calls[0][0].tool).toBe("copy_generate");
    expect(recordToolCall.mock.calls[0][0].artifactPaths).toEqual(["copy.json"]);
  });
});
