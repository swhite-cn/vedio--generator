/**
 * §14.1 最小连通性验证（Phase 7 收口环节）。
 *
 * 目的：在不接触真实 Ark 端点、不读取真实密钥的前提下，验证 Pi SDK 的
 * 「provider 注册 → 会话创建 → 发消息 → 订阅流式事件（text_delta）」链路可用，
 * 用于提前暴露「provider 注册机制 / 会话事件协议」层面的不兼容风险。
 *
 * 范围与边界：
 * - 本脚本只验证 Pi 侧管线的**机制**，**不验证** Ark Agent Plan 端点的协议兼容性；
 *   后者需要用户在本机配置填好真实 `chat_model` 并在 `.env.local` 填好 `ARK_API_KEY` 后单独联调。
 * - 该脚本必须**值导入** Pi SDK，因此放在 `src/agent/` 下（`tests/` 目录在 pnpm 严格隔离下无法解析 Pi 包）；
 *   放在 `src/` 内同时保证它被 `apps/server/tsconfig.json` 的类型检查门禁覆盖。
 * - 本文件是**可执行入口**（顶层即运行），不属于被其它模块 import 的库代码。
 *
 * 运行：`pnpm exec tsx apps/server/src/agent/connectivity-check.ts`
 * 退出码：0 = 通过；1 = 失败（stdout 只输出诊断文本，不写任何机器可读契约）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";

/** mock provider 的注册 ID。 */
const PROVIDER_ID = "mock-ark";
/** mock provider 下的模型 ID。 */
const MODEL_ID = "mock-chat";
/** mock provider 固定回放的文本（分片后应被完整拼回）。 */
const REPLY = "连通性验证成功：这是 mock provider 分片回放的流式文本。";

/**
 * 构造零成本 usage（mock 场景没有真实 token 统计）。
 * @returns 全零的 Usage 对象
 */
function zeroUsage(): Usage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 构造 mock provider 的 `streamSimple`：按固定文本分片回放事件。
 * 事件序列与真实 provider 一致：`start` → `text_start` → `text_delta`* → `text_end` → `done`；
 * 分片（每 6 个字符一片）是为了确保确实产生**多个** `text_delta`，从而验证的是流式增量而非一次性文本。
 * @param reply 要回放的完整文本
 * @returns 与 Pi `StreamFunction` 兼容的实现
 */
function createMockStreamSimple(
  reply: string,
): (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    // 异步回放：模拟真实流式的时间分布，保证 `prompt()` 期间持续产生事件
    void (async () => {
      const usage = zeroUsage();
      const partial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: PROVIDER_ID,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial });

      const contentIndex = 0;
      partial.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial });

      const chunks = reply.match(/.{1,6}/gs) ?? [reply];
      let accumulated = "";
      for (const chunk of chunks) {
        accumulated += chunk;
        partial.content[contentIndex] = { type: "text", text: accumulated };
        stream.push({ type: "text_delta", contentIndex, delta: chunk, partial });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      stream.push({ type: "text_end", contentIndex, content: accumulated, partial });
      stream.push({ type: "done", reason: "stop", message: partial });
      stream.end(partial);
    })();
    return stream;
  };
}

/**
 * 主流程：注册 mock provider → 创建会话 → 发消息 → 收集 `text_delta` → 断言拼接结果。
 * @returns 通过时正常返回，失败时抛出错误（由文件末尾的调用方转成退出码 1）
 */
async function run(): Promise<void> {
  // 用临时目录作 cwd，避免污染仓库与用户 home（默认 agentDir 在 ~/.pi/agent）
  const cwd = mkdtempSync(join(tmpdir(), "vf-connectivity-"));
  try {
    const modelRuntime = await ModelRuntime.create();
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "Mock Ark",
      // baseUrl 不参与本验证（streamSimple 被我们完全接管），给一个不会被访问的占位地址
      baseUrl: "http://127.0.0.1/unused",
      api: "openai-completions",
      apiKey: "mock-key",
      models: [
        {
          type: "chat",
          id: MODEL_ID,
          name: MODEL_ID,
          api: "openai-completions",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: false,
        },
      ],
      streamSimple: createMockStreamSimple(REPLY),
    });

    const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) {
      throw new Error(`无法解析 mock 模型：${PROVIDER_ID}/${MODEL_ID}`);
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, ".pi", "agent"),
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      // 连通性验证不涉及工具调用，禁用全部工具，避免额外的工具回合
      noTools: "all",
    });

    let sawTextDelta = false;
    let streamed = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        sawTextDelta = true;
        streamed += event.assistantMessageEvent.delta;
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    try {
      await session.prompt("请回复一句连通性验证文本");
    } finally {
      unsubscribe();
      session.dispose();
    }
    process.stdout.write("\n");

    if (!sawTextDelta) {
      throw new Error("未收到任何 text_delta 事件，Pi 的流式事件链路可能不兼容");
    }
    if (streamed !== REPLY) {
      throw new Error(`流式文本拼接与预期不一致：期望「${REPLY}」，实际「${streamed}」`);
    }
    console.log("[agent-connectivity] PASS：建会话 → 发消息 → 收 text_delta 全链路可用");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

run().then(
  () => process.exit(0),
  (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[agent-connectivity] FAIL：${detail}`);
    process.exit(1);
  },
);
