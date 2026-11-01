# Pi Agent SDK 1.4.0 API 核对笔记

> 本笔记基于 @earendil-works/pi-coding-agent@1.4.0 实际类型声明与源码，供 Phase 7（agent 运行时）实施参考。

## 0. 证据来源与阅读前提

- **目标包当前未安装**：`<repo>\node_modules\.pnpm\` 下只有 `lock.yaml`，无任何 `@earendil-works/*` 解包目录；`pnpm-lock.yaml` 已解析出 `@earendil-works/pi-coding-agent@1.4.0`。
- **证据获取方式**：从本机 pnpm content-addressable store（`pnpm store path` = `D:\.pnpm-store\v10`）只读重建包内容到系统临时目录（仓库外），再逐一核对类型声明 / 官方文档 / 示例：
  - `%TEMP%\pisdk`（= 包根，含 `dist/`、`docs/`、`examples/`、`package.json`）
  - `%TEMP%\piagentcore`（= `@earendil-works/pi-agent-core@1.4.0`）
  - `%TEMP%\pi-ai`（= `@earendil-works/pi-ai@1.4.0`）
- 下文证据路径以**包内相对路径**给出（安装后即位于 `node_modules/@earendil-works/pi-coding-agent/<path>`）。行号对应该临时副本。
- 关键事实（`package.json`）：
  - `"type": "module"`；`main: ./dist/index.js`；`types: ./dist/index.d.ts`；`exports["."] = { types, import }`；另有 `"./rpc-entry"`。
  - `piConfig.configDir = ".pi"`（即项目内配置目录名，导出常量 `CONFIG_DIR_NAME`）。
  - 依赖：`@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`、`pi-codemode`、`pi-mcp`、`pi-tui`；工具参数 schema 使用 **`typebox@1.3.27`**（非 zod）。
  - **`engines.node = ">=22.19.0"`**（见 §9 冲突项）。
- 全部结论均来自本地类型声明与随包文档/示例，**未联网、未安装**。

---

## 1. 包的导出面

证据：`dist/index.d.ts`（主入口 re-export 清单）。

**会话与工厂（`dist/index.d.ts:3,20`）**

- `AgentSession`（类）、`AgentSessionConfig`、`AgentSessionEvent`、`AgentSessionEventListener`、`PromptOptions`、`ModelCycleResult`、`SessionStats`、`parseSkillBlock`。
- `createAgentSession`、`createAgentSessionFromServices`、`createAgentSessionRuntime`、`createAgentSessionServices`；`AgentSessionRuntime`。
- 内置工具工厂：`createReadTool` / `createBashTool` / `createEditTool` / `createWriteTool` / `createGrepTool` / `createFindTool` / `createLsTool` / `createPowerShellTool` / `createCodingTools` / `createReadOnlyTools`。

**会话持久化（`dist/index.d.ts:21`）**

- `SessionManager`、`buildSessionContext`、`buildSessionProjection`、`buildContextEntries`、`sessionEntryToContextMessages`、`CURRENT_SESSION_VERSION`（= 3），类型 `SessionEntry`、`SessionMessageEntry`、`SessionContext`、`SessionHeader`、`FileEntry` 等。

**模型 / Provider（`dist/index.d.ts:13,15`）**

- `ModelRegistry`、`ModelRuntime`、`CreateModelRuntimeOptions`、`ModelRuntimeAuthOverrides`。

**资源加载（`dist/index.d.ts:19,22,23`）**

- `DefaultResourceLoader`、`loadProjectContextFiles`（第 19 行）。
- `SettingsManager`（第 22 行）。
- `loadSkills`、`loadSkillsFromDir`、`formatSkillsForPrompt`、类型 `Skill`（第 23 行）。

**扩展与工具定义（`dist/index.d.ts:9`）**

- `defineTool`、`createExtensionRuntime`、`discoverAndLoadExtensions`、`ExtensionRunner`、`isToolCallEventType`、`wrapRegisteredTool`。
- 类型（第 8 行）：`ExtensionAPI`、`ExtensionContext`、`ToolDefinition`、`ProviderConfig`、`ProviderModelConfig`、`BeforeProviderRequestEvent`、`AfterProviderResponseEvent`、`ProviderStreamEvent`、`ToolExecutionStartEvent/UpdateEvent/EndEvent` 等。

**其他**：`createEventBus`（第 7 行，`EventBus`）；`readStoredCredential`（第 4 行）；`getAgentDir` / `CONFIG_DIR_NAME` / `VERSION`（第 2 行）；`createSyntheticSourceInfo`（第 24 行，构造内联 `Skill` 用）。

> ⚠ **`AuthStorage` 类未从主入口导出**：`AuthStorage` 定义在 `dist/core/auth-storage.d.ts:44`，但 `dist/index.d.ts` 只导出了 `readStoredCredential`（第 4 行）。主入口的 `exports` 也没有子路径映射到 `./dist/core/*`，因此无法通过 `@earendil-works/pi-coding-agent/...` 稳定导入该内部模块。凭证应走 `ModelRuntime`（见 §4）。

---

## 2. 编程式创建与驱动会话

### 2.1 创建

证据：`dist/core/sdk.d.ts:10-65,116`。

```ts
export declare function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>; // { session, extensionsResult, modelFallbackMessage? }
```

`CreateAgentSessionOptions` 关键字段（`dist/core/sdk.d.ts:10-64`）：

| 字段                                          | 说明                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cwd?`                                        | 项目工作目录，默认 `process.cwd()`；用于资源发现、内置工具路径、会话分组（第 11-12 行）                             |
| `agentDir?`                                   | 全局配置目录，默认 `~/.pi/agent`（第 13-14 行）                                                                     |
| `modelRuntime?`                               | 模型/鉴权运行时；默认基于 `agentDir/auth.json` + `models.json`（第 15-16 行）                                       |
| `model?` / `thinkingLevel?` / `scopedModels?` | 模型选择（第 17-25 行）                                                                                             |
| `noTools?: "all" \| "builtin"`                | 默认工具抑制模式（第 33 行）                                                                                        |
| `tools?: string[]`                            | 工具 allowlist（支持 `*` 通配；`+name`/`-name` 为增删修饰；纯增删列表不能与非通配混用）（第 49 行 + 注释 34-48 行） |
| `excludeTools?: string[]`                     | 工具 denylist（第 54 行）                                                                                           |
| `customTools?: ToolDefinition[]`              | 自定义工具（第 56 行）                                                                                              |
| `resourceLoader?`                             | 资源加载器，省略则用 `DefaultResourceLoader`（第 58 行）                                                            |
| `sessionManager?`                             | 省略则 `SessionManager.create(cwd)`（第 60 行）                                                                     |
| `settingsManager?`                            | 省略则 `SettingsManager.create(cwd, agentDir)`（第 62 行）                                                          |

最小可复制示例（改写自官方 `examples/sdk/01-minimal.ts`）：

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession(); // 复用默认发现：skills/extensions/tools/context files
try {
  await session.prompt("列出当前目录的文件");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose(); // 必须：断开事件、中止活动工作
}
```

### 2.2 事件订阅：流式文本 + 工具调用

`AgentSession.subscribe(listener): () => void`（`dist/core/agent-session.d.ts:384`），事件类型 `AgentSessionEvent`（第 47-109 行），底层为 `AgentEvent`（`pi-agent-core/dist/types.d.ts:452-492`）。

- **流式文本增量**：`event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"` → 取 `event.assistantMessageEvent.delta`（官方 `docs/sdk.md:77-81`、`examples/sdk/01-minimal.ts:13-17`）。
- **工具调用开始/更新/结束**：`tool_execution_start` / `tool_execution_update` / `tool_execution_end`（`pi-agent-core/dist/types.d.ts:474-492`）。`tool_execution_end` 携带 `{ toolCallId, toolName, result, isError, durationMs? }`。
- **轮次与消息边界**：`turn_start` / `turn_end`、`message_start` / `message_end`（`message_end` 是权威完整消息，`docs/sdk.md:92`）。
- **运行结算**：`agent_end`（一次低层运行结束，可能仍有自动重试/排队工作）与 `agent_settled`（Pi 不会自动继续，`docs/sdk.md:92-94`，`agent-session.d.ts:50-59`）。
- **排队状态**：`queue_update`（第 56-59 行）。

```ts
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta); // 流式文本
  } else if (event.type === "tool_execution_start") {
    console.log("tool start", event.toolName, event.toolCallId);
  } else if (event.type === "tool_execution_end") {
    console.log("tool end", event.toolName, "isError=", event.isError);
  }
});
try {
  await session.prompt("开始");
} finally {
  unsubscribe();
}
```

> `subscribe()` 的监听器同样会被 `AgentSession` 用于内部持久化；`message_end` 时自动落盘。

### 2.3 中断、转向（steer / followUp）

证据：`dist/core/agent-session.d.ts:176-188,553,574-587,631-634,654-655`。

- `abort(): Promise<void>`（第 654 行）——中止当前操作并等待 idle；`waitForIdle()`（第 655 行）只等待不中止。
- `prompt(text, options?)`（第 553 行）：**流式期间调用必须显式指定 `options.streamingBehavior: "steer" | "followUp"`，否则拒绝**（第 182-183 行注释；`docs/sdk.md:66`）。
- `steer(text, images?, options?)`（第 574 行）：在当前 assistant 回合及其工具调用**之后**、下一次 LLM 调用前投递。
- `followUp(text, images?, options?)`（第 585 行）：在当前运行所有待办工作**结束之后**投递。
- 两者都返回 `QueuedInputDisposition = "handled" | "queued"`（第 174 行）；`clearQueue()` 可回收未投递队列（第 640 行）。
- `sendUserMessage(content, { deliverAs?, expandPromptTemplates? })`（第 631 行）：始终触发一个回合；流式时用 `deliverAs` 指定排队方式。
- `sendCustomMessage(message, { triggerTurn?, deliverAs? })`（第 613 行）：注入自定义消息（可写入数据库留痕用途见 §3）。
- `isStreaming` / `isIdle`（第 410-412 行）。

VideoForge 的“阶段指令注入”可映射为：状态机在合适时机调用 `session.steer(阶段指令)` 或 `session.followUp(...)`。

### 2.4 会话上的其他常用方法

`getActiveToolNames()`（第 421 行）、`setActiveToolsByName(names)`（第 435 行）、`getAllTools(): ToolInfo[]`（第 427 行）、`getToolDefinition(name)`（第 428 行）、`messages`（第 465 行）、`state`（第 395 行）、`systemPrompt`（第 414 行）、`getSessionStats()`（第 892 行）、`exportToJsonl(path?)`（第 909 行）。

---

## 3. 会话内部消息状态与历史重建

### 3.1 状态中的消息字段

- `AgentSession.state: AgentState`（`agent-session.d.ts:395`）；`AgentSession.messages: AgentMessage[]`（第 465 行，含自定义类型消息）。
- `AgentState`（`pi-agent-core/dist/types.d.ts:329-368`）：消息属性名就是 **`messages`**（`set messages(...)` / `get messages()`，第 354-355 行）；另有 `systemPrompt`（第 336 行）、`model`、`thinkingLevel`、`isStreaming`、`streamingMessage`、`pendingToolCalls`。
- `AgentMessage = Message | CustomAgentMessages[keyof ...]`；`Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`（`pi-ai/dist/types.d.ts:436`）。
- 内容块类型（`pi-ai/dist/types.d.ts`）：
  - `TextContent { type: "text"; text }`（第 252 行）
  - `ThinkingContent { type: "thinking"; thinking }`（第 257 行）
  - `ImageContent { type: "image"; data; mimeType }`（第 266 行）
  - `ToolCall { type: "toolCall"; id; name; arguments }`（第 271 行）
  - `SystemMessage`（第 346 行）/`UserMessage`（第 363 行）/`AssistantMessage`（第 368 行，`content: (TextContent|ThinkingContent|ToolCall)[]`）/`ToolResultMessage`（第 420 行，含 `toolCallId/toolName/content/isError`）。

### 3.2 历史重建：**不能靠赋值 `state.messages`**

官方明确（`docs/sdk.md:40`）：

> `SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. **Assigning `session.agent.state.messages` does not replace persisted context.**

因此，用数据库历史消息重建上下文有两种官方途径（`dist/core/session-manager.d.ts`）：

1. **逐条追加（推荐，最简单）**：`SessionManager.inMemory(cwd)` 创建内存会话，再按时间顺序 `appendMessage(message)`（第 386、263 行）。`appendMessage` 接受 `Message | CustomMessage | BashExecutionMessage`，内部维护 `id/parentId` 树链。
2. **直接注入 entries**：`SessionManager.inMemory(cwd?, options?, entries?: FileEntry[])`（第 386 行）。`FileEntry = SessionHeader | SessionEntry`（第 130 行）；`SessionMessageEntry = { type: "message"; message: AgentMessage; id; parentId; timestamp }`（第 23-26 行）。适合已持有完整 JSONL 条目的场景。

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const cwd = "D:\\...\\workspace\\demo";
const sm = SessionManager.inMemory(cwd);
for (const m of historicalMessages as AgentMessage[]) {
  sm.appendMessage(m as any); // 逐条重放数据库历史消息
}
const { session } = await createAgentSession({ cwd, sessionManager: sm });
```

只读解析辅助函数（均可从主入口导入，`dist/index.d.ts:21`）：`buildSessionContext(entries, leafId?, byId?)`、`buildSessionProjection(...)`、`sessionEntryToContextMessages(entry)`（`session-manager.d.ts:189,200,202`）；`SessionContext = { messages: AgentMessage[]; thinkingLevel: string; model: {provider; modelId} | null }`（第 155 行）。

> 注：`session.agent.state.messages` 仍可读，用于监控/渲染；但把它当作“恢复入口”是无效的——这是 §9 的假设不成立项之一。

---

## 4. 模型 Provider 注册 与 LLM 全文留痕

### 4.1 注册一个 OpenAI 兼容 provider（可行）

证据：`dist/core/provider-composer.d.ts:50-63`（`ProviderConfigInput`）、`dist/core/extensions/types.d.ts:1414-1466`（`ProviderConfig`）、`dist/core/model-runtime.d.ts:117`、`dist/core/model-registry.d.ts:54-55`、`docs/custom-provider.md:51-78`。

注册入口（二者签名一致）：

- `ModelRuntime.registerProvider(providerId: string, config: ProviderConfigInput)`（`model-runtime.d.ts:117`）
- `ModelRegistry.registerProvider(providerName: string, config: ProviderConfigInput)`（`model-registry.d.ts:55`）
- 扩展内：`pi.registerProvider(name, ProviderConfig)`（`ExtensionAPI`，见 §6）

`ProviderConfigInput`（`provider-composer.d.ts:50-63`）：

```ts
interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;         // ← 任意自定义端点
  apiKey?: string;          // ← 支持 $ENV_VAR / ${ENV_VAR} / !command（见 docs/custom-provider.md:128-133）
  api?: Api;                // ← 如 "openai-completions"
  streamSimple?: (...) => AssistantMessageEventStream;
  images?; classifiers?; headers?: Record<string,string>; authHeader?: boolean;
  oauth?: ...; models?: ProviderModelConfig[]; refreshModels?;
}
```

兼容 OpenAI Chat Completions 的注册示例（官方 `docs/custom-provider.md:58-77` 改写）：

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
modelRuntime.registerProvider("ark", {
  name: "Ark Agent Plan",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  apiKey: "$ARK_API_KEY", // 从系统环境变量插值；密钥不落库
  api: "openai-completions",
  models: [
    {
      type: "chat",
      id: "<chat_model_id>",
      name: "<chat_model_id>",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
});
const { session } = await createAgentSession({
  modelRuntime,
  model: modelRuntime.getModel("ark", "<chat_model_id>"),
});
```

- **是否需要 `AuthStorage`**：**不需要**。可用 `ModelRuntime.setRuntimeApiKey(providerId, apiKey)`（`model-runtime.d.ts:93`）或 `ProviderConfigInput.apiKey` 环境插值。
- **ARK 端点兼容性**：SDK 侧不限制 `baseUrl`，是否可注册与端点是否说 OpenAI 协议是两件事——官方要求“以实际服务核对请求/响应字段”（`docs/custom-provider.md:149-151`）。**`/api/plan/v3` 是否严格 OpenAI-Chat-Completions 兼容须在 Phase 7 运行时实测**（属"待实测"，非"不成立"）。若协议不同，走 `api` 换型或自定义 `streamSimple`。

### 4.2 LLM 请求/响应全文留痕

可用钩子（两处）：

- 扩展事件（`dist/core/extensions/types.d.ts:692-719`）：
  - `before_provider_request` → `BeforeProviderRequestEvent { payload: unknown }`（第 693-696 行）：**可拿到完整请求体**，并可返回替换 payload。
  - `before_provider_headers`（第 702 行）、`after_provider_response` → `{ status: number; headers: Record<string,string> }`（第 707-711 行）：**只有状态码和响应头，无响应正文**。
  - `provider_stream_event` → `{ provider, api, model, data: unknown }`（第 713-719 行）：**每个解析后的流事件**，可用于重建响应。
- 流层回调（`pi-ai/dist/types.d.ts`）：`ProviderRequestOptions.onPayload(payload, model)`（第 69 行）、`onResponse(response: ProviderResponse, model)`（第 73 行，`ProviderResponse = { status; headers }`，第 43-46 行，**仍无 body**）、`StreamOptions.onProviderStreamEvent(data, model)`（第 118 行）。

**结论**：

- ✅ 请求体全文：`before_provider_request.payload`（官方配方见 `examples/extensions/provider-payload.ts:6-12`）。
- ❌ 响应体正文：**没有任何钩子直接暴露 HTTP 响应正文**（`after_provider_response`/`onResponse` 仅 `{status, headers}`）。
- 可行替代（择一）：
  1. **自定义 `streamSimple`**：在自己实现的 provider 里于发送处/消费处自行落库请求与响应全文（官方要求自定义流必须调用 `options.onPayload`/`options.onResponse`/`onProviderStreamEvent`，见 `docs/custom-provider.md:191-198`、`types.d.ts:1423-1432`）。这是唯一能拿到"完整原始响应"的路径。
  2. **组合钩子重建**：`before_provider_request` 落请求；`provider_stream_event`（或 `message_end` 的权威 message）落响应内容块与用量。可满足"自有代码留痕"，但拿到的是规范化后的事件流，不是原始字节。

> 对 VideoForge 的 `llm_calls` 全文留痕：**请求侧可直接用钩子**；**响应侧若要求"原始响应全文"必须自实现 `streamSimple` 或退而记录规范化消息（`message_end`）**。

---

## 5. 内置工具与选择性启用

证据：`dist/core/tools/index.d.ts`。

- 工具名联合类型（第 23 行）：`"read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls"`。
- `allToolNames: Set<ToolName>`（第 24 行）。
- 工厂函数：`createReadTool` / `createBashTool` / `createEditTool` / `createWriteTool` / `createGrepTool` / `createFindTool` / `createLsTool` / `createPowerShellTool`（第 1-10 行），以及 `createCodingTools(cwd, options?)`（第 40 行，默认组合）、`createReadOnlyTools(cwd, options?)`（第 41 行）、`createAllTools(cwd, options?)`（第 42 行）；对应的 `createXxxToolDefinition` 变体（第 35-39 行）。

选择性启用（官方 `examples/sdk/05-tools.ts`）：

- 在 `createAgentSession` 传 `tools: [...]`（allowlist）/ `excludeTools: [...]`（denylist）/ `noTools: "all" | "builtin"`（§2.1）。
- 运行时：`session.getActiveToolNames()` / `session.setActiveToolsByName(names)` / `session.getAllTools()`（`agent-session.d.ts:421,435,427`）；变更在下一个回合生效（第 433 行注释）。
- 扩展事件亦可 `pi.setActiveTools(...)` / `pi.getActiveTools()`（`examples/extensions/tools.ts:35,62`）。

VideoForge 的 `bash/write/edit` 开关映射：

- 全关：`tools: ["read","grep","find","ls"]`（只读，官方示例第 16-19 行）。
- 开 bash 关写：`tools: ["read","grep","find","ls","bash"]`。
- 开写：把 `"write"`、`"edit"` 加入列表；或运行时用 `setActiveToolsByName`。

> 内置工具**没有** `ToolName` 之外的名字；`bash` 与 `powershell` 是并列的两个工具（`powershell` 仅 Windows）。

---

## 6. 自定义工具注册与错误回传

证据：`dist/core/extensions/types.d.ts:453-519`（`ToolDefinition`）、`dist/core/extensions/types.d.ts:1229`（`registerTool`）、`dist/index.d.ts:9`（`defineTool`）、`examples/sdk/06-extensions.ts`。

- **参数 schema 用 TypeBox**（`TSchema`），非 zod（`ToolDefinition.parameters: TParams`，第 465 行；`typebox@1.3.27`）。
- `ToolDefinition` 关键字段（第 453-519 行）：`name`、`label`、`description`、`promptSnippet?`、`promptGuidelines?`、`parameters`、`outputSchema?`、`exposure?`（默认 `"direct"`）、`defaultActive?`、`executionMode?`（`"sequential" | "parallel"`）、`execute(...)`。
- `execute` 签名（第 514 行）：

```ts
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionToolContext
): Promise<AgentToolResult<TDetails>>;
```

- 返回结构 `AgentToolResult`（`pi-agent-core/dist/types.d.ts:370-392`）：`content: (TextContent|ImageContent)[]`、`details`、`structuredContent?`、`usage?`、`isError?`、`terminate?`。

注册方式：

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "copy_gen",
      label: "Copy Gen",
      description: "生成文案并写入 copy.json",
      parameters: Type.Object({ topic: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: `ok:${params.topic}` }],
        details: { path: "..." },
      }),
    }),
  );
}
```

（也可在 `createAgentSession({ customTools: [...] })` 直接传入 `ToolDefinition[]`，见 `dist/core/sdk.d.ts:56`。）

**错误回传 (`tool_end.errorCode` 相关)**：

- ❌ SDK 公共 API **没有 `errorCode` 字段**。`AgentToolResult` 只有 `isError?: boolean`（`pi-agent-core/dist/types.d.ts:386`）；`message_end` / `tool_execution_end` 事件也无 `errorCode`。
- 约定做法：`throw` 或返回 `{ isError: true, content: [...], details: { errorCode } , structuredContent: {...} }`；把错误码编码进 `content`（模型可见）与 `structuredContent`/`details`（程序可见，第 375-379 行注释：`structuredContent` 不发给模型）。**即 VideoForge 的 `tool_end.errorCode` 需由自定义约定承载，SDK 不原生存放。**

---

## 7. 系统提示注入 与 技能发现

### 7.1 系统提示（可用，但签名要修正）

证据：`dist/core/resource-loader.d.ts:70-124`（`DefaultResourceLoaderOptions`）、`examples/sdk/03-custom-prompt.ts`、双入口 `dist/index.d.ts:19`。

`DefaultResourceLoader` 相关字段：

- `systemPrompt?: string`（第 87 行）——**直接给完整字符串**。
- `appendSystemPrompt?: string[]`（第 88 行）。
- `systemPromptOverride?: (base: string | undefined) => string | undefined`（第 122 行）——**函数式覆盖，不是字符串**。
- `appendSystemPromptOverride?: (base: string[]) => string[]`（第 123 行）。
- 其他：`additionalSkillPaths` / `additionalExtensionPaths` / `extensionFactories` / `noSkills` / `skillsOverride`（第 76-96 行）。

> 设计文档 §5.6 写 `DefaultResourceLoader({ systemPromptOverride })`：**语义可用，但类型是函数 `(base) => string | undefined`**。若要注入固定提示，最简写法是 `systemPrompt: "..."`；如要改动默认发现的提示，用 `systemPromptOverride: () => "..."` 并配 `appendSystemPromptOverride: () => []` 避免额外追加（官方示例 `03-custom-prompt.ts:18-25`）。

自定义 `ResourceLoader` 接口（`resource-loader.d.ts:32-62`）：需实现 `getSystemPrompt()`（第 52 行）、`getExtensions/getSkills/getPrompts/getThemes/getAgentsFiles/extendResources/reload` 等；完整替换示例见 `examples/sdk/12-full-control.ts:36-49`。

### 7.2 技能发现与渐进式披露（可用）

证据：`dist/core/skills.d.ts`、`docs/skills.md`、`dist/core/settings-schema.d.ts`、`examples/sdk/04-skills.ts`。

- `Skill`（`skills.d.ts:9-16`）：`{ name; description; filePath; baseDir; sourceInfo; disableModelInvocation }`。
- 发现规则 `loadSkillsFromDir({ dir, source })`（第 27-35 行注释）：目录含 `SKILL.md` → 视为 skill root 不递归；否则加载根目录 `.md`；再递归子目录找 `SKILL.md`。
- 渐进式披露 `formatSkillsForPrompt(skills, fileReadTool?)`（第 47 行）：系统提示只加 name/description/path，模型按需读取 `SKILL.md`（`docs/skills.md:43-45`）；`disable-model-invocation: true` 的技能被排除（第 41-42 行注释）。
- **settings 的 `skills` 是合法资源设置项**：`settings-schema.d.ts:71,128,134,155,227`（`skills?: string[]`、`defaultTools?: string[]`）；`SettingsManager.getSkillPaths()`（`settings-manager.d.ts:194`）。
- 项目内 `.pi/settings.json` 的 `skills` 相对路径**从项目 `.pi` 目录解析**（`docs/settings.md:150`）；`cwd` 决定项目 `.pi` 位置（`docs/sdk.md:54`）。
- 也可绕过 settings：`DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths: ["../.trae/skills"] })`（`resource-loader.d.ts:76`），或在 `skillsOverride` 里加内联 `Skill`（`examples/sdk/04-skills.ts:27-37`）。

> VideoForge 设计里 `.pi/settings.json` 的 `{"skills": ["../.trae/skills"]}` **可行**（相对项目 `.pi` 解析），但需要把 `.pi` 建在被锁定的项目目录下，并确保 `cwd` 指向该目录。

---

## 8. 会话的 cwd / 工作目录

证据：`dist/core/sdk.d.ts:11-12`、`dist/core/session-manager.d.ts:371,386`、`docs/sdk.md:54`、`examples/sdk/05-tools.ts:31-37`。

- `createAgentSession({ cwd })` 决定：项目资源发现、context files、会话分组、**内置工具路径**（`docs/sdk.md:54`）；默认 `process.cwd()`。
- `SessionManager.inMemory(cwd?, options?, entries?)` / `SessionManager.create(cwd, sessionDir?, options?)` 的 `cwd` 写入 `SessionHeader.cwd`（`session-manager.d.ts:10`）。
- 内置工具工厂 `createXxxTool(cwd, options?)` 显式接收 cwd（`tools/index.d.ts:35-42`）；用 `createAgentSession({ cwd })` 时会用该 cwd 构建内置工具（`examples/sdk/05-tools.ts` 注释）。
- 自定义工具的 `execute` 通过 `ctx: ExtensionToolContext` 拿上下文（`types.d.ts:514`）。

**没有发现进程级/per-session 的 OS 沙箱配置**：SDK 未提供 confine/容器化开关；安全边界仍靠“cwd 锁定 + 工具 allowlist + 自定义工具内自行做路径校验”实现。

---

## 9. "设计假设不成立"清单

| #   | 设计文档假设                                                    | 实测结论                                                                                        | 最小替代方案                                                                                                                                |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §5.3 用 `AuthStorage` 注册/管理凭证                             | `AuthStorage` 类**未从主入口导出**（仅 `readStoredCredential`；无子路径 exports 指向 `core/*`） | 用 `ModelRuntime.setRuntimeApiKey(providerId, key)` 或 `ProviderConfigInput.apiKey: "$ARK_API_KEY"`                                         |
| 2   | §5.6 `DefaultResourceLoader({ systemPromptOverride })` 传字符串 | 实际类型为 `(base: string \| undefined) => string \| undefined`                                 | 固定提示用 `systemPrompt: "..."`；改默认为 `systemPromptOverride: () => "..."` + `appendSystemPromptOverride: () => []`                     |
| 3   | §7.2 通过 response 钩子拿 LLM **响应全文字段**                  | `after_provider_response` 与 `onResponse` 只有 `{ status, headers }`，**无 body**               | 自实现 `streamSimple` 落库原始响应；或组合 `before_provider_request.payload`（请求全文）+ `provider_stream_event`/`message_end`（响应内容） |
| 4   | §5.2/§14.3 通过赋值 `session.agent.state.messages` 恢复上下文   | 官方明确**赋值不会替换持久化上下文**（`docs/sdk.md:40`）                                        | 用 `SessionManager.inMemory(cwd)` + `appendMessage()` 逐条重放；或 `SessionManager.inMemory(cwd, options, entries)` 注入 `FileEntry[]`      |
| 5   | `tool_end.errorCode` 为 SDK 公共字段                            | 公共类型**无 `errorCode`**；仅有 `AgentToolResult.isError`                                      | 约定：`{ isError: true, structuredContent: { errorCode }, details: { errorCode } }`，错误码同时写进 `content` 供模型阅读                    |
| 6   | 仓库要求 Node 20+（AGENTS.md）                                  | 包 `engines.node = ">=22.19.0"`                                                                 | 升级运行环境到 Node ≥ 22.19.0，或评估降级/忽略引擎（风险自担）                                                                              |
| 7   | 目标包"已安装"                                                  | `node_modules` 中**未安装**（`.pnpm` 仅有 `lock.yaml`）                                         | Phase 7 前先 `pnpm install`，否则无法 `import`                                                                                              |
| 8   | ARK `/api/plan/v3` 可直接用于 OpenAI 兼容注册                   | SDK 不限制 baseUrl，但端点协议兼容性**未在本地验证**                                            | Phase 7 运行时实测请求/响应字段；不兼容则换 `api` 或自实现 `streamSimple`                                                                   |
| 9   | 工具参数 schema 可能是 zod（仓库根依赖含 zod@^4.6.5）           | SDK 用 **TypeBox `TSchema`**（`typebox@1.3.27`）                                                | 自定义工具用 `typebox` 的 `Type.*` 定义参数；不要把 zod 传给 `parameters`                                                                   |

---

## 附：官方示例与文档索引（随包，可直接参考）

| 主题                               | 路径（包内）                                              |
| ---------------------------------- | --------------------------------------------------------- |
| 最小会话 / 流式文本                | `examples/sdk/01-minimal.ts`                              |
| 模型与 thinkingLevel               | `examples/sdk/02-custom-model.ts`                         |
| 系统提示替换/追加                  | `examples/sdk/03-custom-prompt.ts`                        |
| 技能发现/过滤/内联                 | `examples/sdk/04-skills.ts`                               |
| 内置工具与 cwd                     | `examples/sdk/05-tools.ts`                                |
| 扩展与自定义工具                   | `examples/sdk/06-extensions.ts`                           |
| 凭证与模型存储                     | `examples/sdk/09-api-keys-and-oauth.ts`                   |
| 会话持久化/恢复/列举               | `examples/sdk/11-sessions.ts`                             |
| 完全替换默认服务                   | `examples/sdk/12-full-control.ts`                         |
| 请求体留痕配方                     | `examples/extensions/provider-payload.ts`                 |
| 自定义 provider（含自实现 stream） | `examples/extensions/custom-provider-gitlab-duo/index.ts` |
| SDK 用法文档                       | `docs/sdk.md`                                             |
| 自定义 provider 文档               | `docs/custom-provider.md`                                 |
| 技能文档                           | `docs/skills.md`                                          |
