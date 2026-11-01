import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARK_PLACEHOLDER_CHAT_MODEL, callArkChat } from "../../apps/server/src/agent/pi/ark-chat";
import {
  createArkModelRuntime,
  createArkStreamSimple,
} from "../../apps/server/src/agent/pi/provider";
import { createRedactor } from "../../apps/server/src/trace/redact";
import type { TraceStore } from "../../apps/server/src/trace/trace-store";

/**
 * Ark provider + LLM 全文留痕单测（Phase 7 Step 1）。
 * 全部使用 mock 全局 fetch 与临时 rootDir，不读开发机 gitignored 的 config/system.local.yaml。
 */

/** 火山方舟 Agent Plan 专用基础地址（严禁 /api/v3，改为 /api/v3 会产生额外费用）。 */
const REAL_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

/** 测试用假密钥（长度 > 6，确保参与脱敏替换）。 */
const FAKE_SECRET = "sk-test-verysecretvalue123";

/** 生成满足当前 schema 的最小 default.yaml 文本。 */
function minimalDefaultYaml(options: { baseUrl?: string; chatModel?: string } = {}): string {
  return [
    "server:",
    "  port: 3000",
    '  jwt_secret_env: "JWT_SECRET"',
    '  access_token_ttl: "12h"',
    "  allow_registration: true",
    '  admin_password_env: "VF_ADMIN_INITIAL_PASSWORD"',
    "  max_projects_per_user: 50",
    "runtime:",
    '  storage_root: "storage"',
    "  max_concurrent_stage: 1",
    "  minimum_free_disk_gb: 30",
    "tools:",
    '  chromium_path: ""',
    '  ffmpeg_path: "ffmpeg"',
    '  ffprobe_path: "ffprobe"',
    "agent:",
    "  allow_shell_write_edit: true",
    "workflow:",
    "  max_stage_retry: 2",
    "engines:",
    "  endpoints:",
    "    ark:",
    `      base_url: "${options.baseUrl ?? REAL_BASE_URL}"`,
    `      chat_model: "${options.chatModel ?? "test-chat-model"}"`,
    '      image_model: "test-image-model"',
    '      tts_speaker: "test-speaker"',
    '      tts_base_url: "https://openspeech.example/api/v3/plan/tts/unidirectional"',
    '      tts_resource_id: "seed-tts-2.0"',
    "",
  ].join("\n");
}

/** 把若干 SSE 分片对象拼成标准 SSE 文本（尾部追加 [DONE]）。 */
function makeSse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** 构造一个返回给定 SSE 文本的 Response。 */
function sseResponse(chunks: unknown[]): Response {
  return new Response(makeSse(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Ark provider（Phase 7 Step 1）", () => {
  const dirs: string[] = [];
  const originalArkKey = process.env.ARK_API_KEY;

  /** 创建带最小 config/default.yaml 的临时根目录并登记清理。 */
  function makeRoot(options: { baseUrl?: string; chatModel?: string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "vf-ark-provider-"));
    dirs.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config/default.yaml"), minimalDefaultYaml(options), "utf-8");
    return root;
  }

  beforeEach(() => {
    // 默认注入假密钥；个别用例自行覆盖
    process.env.ARK_API_KEY = FAKE_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalArkKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalArkKey;
  });

  it("成功路径：聚合文本 / finish_reason / token，并记录请求与响应全文", async () => {
    const rootDir = makeRoot();
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { content: "你好" } }] },
        { choices: [{ index: 0, delta: { content: "，世界" } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callArkChat({
      rootDir,
      messages: [{ role: "user", content: "写一段文案" }],
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("你好，世界");
    expect(result.finishReason).toBe("stop");
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(7);
    // 请求全文含 messages
    expect(result.requestJson).toMatchObject({
      model: "test-chat-model",
      stream: true,
      messages: [{ role: "user", content: "写一段文案" }],
    });
    // 归一化响应含 finishReason
    expect(result.responseJson).toMatchObject({
      content: "你好，世界",
      finishReason: "stop",
    });
    // 请求体绝不含密钥
    expect(JSON.stringify(result.requestJson)).not.toContain(FAKE_SECRET);
  });

  it("请求端点固定为 Agent Plan 基础地址，不含 /api/v3/（防回归）", async () => {
    const rootDir = makeRoot();
    const fetchMock = vi.fn(async () =>
      sseResponse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callArkChat({ rootDir, messages: [{ role: "user", content: "hi" }] });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe(`${REAL_BASE_URL}/chat/completions`);
    expect(url).not.toContain("/api/v3/");
  });

  it("多工具调用的增量按 index 正确聚合", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "copy_generate", arguments: '{"topic"' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: ':"黑洞"}' } }] },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 1,
                      id: "call_2",
                      function: { name: "image_generate", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );

    const result = await callArkChat({ rootDir, messages: [{ role: "user", content: "go" }] });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "copy_generate", arguments: '{"topic":"黑洞"}' },
      { id: "call_2", name: "image_generate", arguments: "{}" },
    ]);
  });

  it("HTTP 500 时返回 ok:false 与 TOOL_UNAVAILABLE，且不抛出", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const result = await callArkChat({ rootDir, messages: [{ role: "user", content: "hi" }] });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TOOL_UNAVAILABLE");
    expect(result.content).toBe("");
  });

  it("网络异常时返回 ok:false 与 TOOL_UNAVAILABLE，且不抛出", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    const result = await callArkChat({ rootDir, messages: [{ role: "user", content: "hi" }] });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TOOL_UNAVAILABLE");
  });

  it("响应不符合 SSE 协议时返回 ok:false 与 ADAPTER_PROTOCOL_INVALID", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-an-sse-body", { status: 200 })),
    );

    const result = await callArkChat({ rootDir, messages: [{ role: "user", content: "hi" }] });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ADAPTER_PROTOCOL_INVALID");
  });

  it("chat_model 为占位值时 callArkChat 与 createArkModelRuntime 均抛 CONFIG_INVALID", async () => {
    const rootDir = makeRoot({ chatModel: ARK_PLACEHOLDER_CHAT_MODEL });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callArkChat({ rootDir, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
    await expect(createArkModelRuntime({ rootDir })).rejects.toThrowError(/CONFIG_INVALID/);
    // 占位值校验发生在请求之前
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("转录中的工具声明会透传到 Ark 请求体（防回归：缺 tools 会导致阶段永不调用工具）", async () => {
    const rootDir = makeRoot();
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "copy_generate", arguments: "{}" } },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const streamFn = createArkStreamSimple({ rootDir }) as unknown as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => { result(): Promise<unknown> };

    // Pi 把工具声明编码在 system 消息的 toolsAdded 中（TranscriptContext 只携带 messages）
    const stream = streamFn(
      { id: "test-chat-model" },
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "你是视频流水线执行器" }],
            toolsAdded: [
              {
                name: "copy_generate",
                description: "生成文案",
                parameters: {
                  type: "object",
                  properties: { topic: { type: "string" } },
                  required: ["topic"],
                },
              },
            ],
            timestamp: Date.now(),
          },
          { role: "user", content: "请生成文案", timestamp: Date.now() },
        ],
      },
    );
    await stream.result();

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(requestBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "copy_generate",
          description: "生成文案",
          parameters: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"],
          },
        },
      },
    ]);
    expect(requestBody.tool_choice).toBe("auto");
  });

  it("每次请求结束都写入 LLM 全文留痕，且明文密钥被脱敏为 ***", async () => {
    const rootDir = makeRoot();
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          choices: [
            { index: 0, delta: { content: `你说的密钥是 ${FAKE_SECRET}` }, finish_reason: "stop" },
          ],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const captured: Array<{ request: unknown; response: unknown; ok: boolean; model: string }> = [];
    // 与真实 trace-store 一致的脱敏器；假 store 只收集参数，无需真库
    const redact = createRedactor(rootDir);
    const store = {
      recordLlmCall: (input: any) => {
        captured.push({
          request: redact(input.request),
          response: redact(input.response),
          ok: input.ok,
          model: input.model,
        });
        return {} as never;
      },
      recordToolCall: () => {
        throw new Error("本用例不应调用 recordToolCall");
      },
      recordStage: () => {
        throw new Error("本用例不应调用 recordStage");
      },
    } as unknown as TraceStore;

    const streamFn = createArkStreamSimple({
      rootDir,
      trace: store,
      traceContext: { sessionId: "session-1" },
    }) as unknown as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => { result(): Promise<unknown> };

    const stream = streamFn(
      { id: "test-chat-model" },
      {
        messages: [{ role: "user", content: `我的密钥是 ${FAKE_SECRET}`, timestamp: Date.now() }],
      },
    );
    await stream.result();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.model).toBe("test-chat-model");
    expect(captured[0]!.ok).toBe(true);
    const requestDump = JSON.stringify(captured[0]!.request);
    const responseDump = JSON.stringify(captured[0]!.response);
    expect(requestDump).not.toContain(FAKE_SECRET);
    expect(responseDump).not.toContain(FAKE_SECRET);
    expect(requestDump).toContain("***");
    expect(responseDump).toContain("***");
  });

  it("共享运行时下按 streamOptions.sessionId 解析留痕目标，写入 runId / stageId", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]),
      ),
    );

    const captured: Array<{ sessionId: string; runId?: string | null; stageId?: string | null }> =
      [];
    const store = {
      recordLlmCall: (input: any) => {
        captured.push({ sessionId: input.sessionId, runId: input.runId, stageId: input.stageId });
        return {} as never;
      },
      recordToolCall: () => {
        throw new Error("本用例不应调用 recordToolCall");
      },
      recordStage: () => {
        throw new Error("本用例不应调用 recordStage");
      },
    } as unknown as TraceStore;

    const streamFn = createArkStreamSimple({
      rootDir,
      resolveTraceTarget: (sessionId) =>
        sessionId === "session-2"
          ? { trace: store, context: { sessionId, runId: "run-1", stageId: "stage-1" } }
          : undefined,
    }) as unknown as (
      model: unknown,
      context: unknown,
      options?: unknown,
    ) => { result(): Promise<unknown> };

    const stream = streamFn(
      { id: "test-chat-model" },
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { sessionId: "session-2" },
    );
    await stream.result();

    expect(captured).toEqual([{ sessionId: "session-2", runId: "run-1", stageId: "stage-1" }]);
  });

  it("解析不到留痕目标时静默跳过，不影响流式结果", async () => {
    const rootDir = makeRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]),
      ),
    );

    const streamFn = createArkStreamSimple({
      rootDir,
      resolveTraceTarget: () => undefined,
    }) as unknown as (model: unknown, context: unknown, options?: unknown) => { result(): unknown };

    const stream = streamFn(
      { id: "test-chat-model" },
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { sessionId: "unknown-session" },
    );
    await expect(stream.result()).resolves.toBeTruthy();
  });
});
