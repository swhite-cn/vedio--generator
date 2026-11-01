# Ark Skill 视频流水线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建稳定的科普/历史视频生成流水线：4 个 Trae skill（文案/生图/TTS/分镜）+ 2 个基础能力（逐帧渲染、视频合成，经 CLI 暴露）+ Web 监控站。

**Architecture:** harness 主导编排（A 方案）。skill 是薄封装——SKILL.md 指导 Trae/OpenClaw 里的 agent 调用本仓库 CLI 命令；CLI 命令桥接火山方舟 Agent Plan（AI 供给）与本地积木（renderBuild / composeVideo / buildTimeline）。Web 仅做监控与物料预览，不参与编排。

**Tech Stack:** pnpm monorepo、TypeScript（严格模式 + ESM + NodeNext）、Fastify、Vue 3、Vitest、火山方舟 Agent Plan（chat completions / images/generations / openspeech TTS）。

---

## 背景与已对齐决策

- 使用场景：在 Trae、OpenClaw 等 harness 框架中由 agent 按 skill 说明逐步驱动，生成视频。
- skill 交付形态：Trae skill 规范（`.trae/skills/<name>/SKILL.md` + 脚本）。
- Ark Agent Plan 端点（以用户控制台截图为准）：
  - Base URL：`https://ark.cn-beijing.volces.com/api/plan/v3`（**严禁用 /api/v3，会产生额外费用**）
  - 图片生成：`POST {base}/images/generations`，模型 `doubao-seedream-5-0-pro-260628`
  - TTS：`POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，Resource-Id `seed-tts-2.0`，NDJSON 流式返回
  - 语言模型：OpenAI 兼容 `POST {base}/chat/completions`，**模型 ID 用配置占位，待用户填写**
- 仓库现状关键约束（调研确认）：
  1. 无 dotenv 依赖、无任何代码读取 `.env.local`/`process.env` → 需新建环境加载机制（Task 1）。
  2. `SceneData` 与 `renderMinimalScene` 不支持图片 → skill2 图片进渲染必须扩展模板 SDK（Task 4）。
  3. 现有测试均不引用 minimal-scene/renderBuild/composeVideo → 扩展模板不破坏既有测试。
  4. 密钥只允许出现在 `.env.local`（已 gitignore），不得入日志/manifest/测试快照。

## 任务总览

| #   | 任务                             | 产出                                                                      |
| --- | -------------------------------- | ------------------------------------------------------------------------- |
| 1   | 环境变量加载机制                 | `pipeline/env.ts` + 测试                                                  |
| 2   | 配置扩展 `engines.endpoints.ark` | default.yaml / config.ts / example / 测试                                 |
| 3   | Ark HTTP 客户端                  | `pipeline/ark-client.ts` + 测试                                           |
| 4   | 模板 SDK 支持图片场景            | contracts.ts / minimal-scene.ts + 测试                                    |
| 5   | 辅助积木：时长/拼接/多场景渲染   | `pipeline/media.ts` / `renderer/render-sequence.ts` + 测试                |
| 6   | CLI 六个命令                     | copy:gen / image:gen / tts:gen / storyboard:gen / render / compose + 测试 |
| 7   | 四个 Trae skill                  | `.trae/skills/vf-*/SKILL.md`                                              |
| 8   | Web 监控扩展                     | 工作区物料预览 + 产物播放                                                 |
| 9   | 冒烟验证 + 文档                  | 指南更新                                                                  |

**通用约定（每个任务都必须遵守）：**

- TDD：先写失败测试 → 验证失败 → 最小实现 → 验证通过。
- 测试名为中文；import 不带 `.js` 扩展名（对齐现有测试风格）。
- 新增/修改函数添加简洁的中文函数级注释。
- 文件路径兼容 Windows（中文/空格/正斜杠），安全敏感路径复用 `path-safety.ts`。
- 除非用户明确要求，不创建 git commit。

---

## Task 1: 环境变量加载机制（ARK_API_KEY）

仓库当前无 dotenv、无代码读取 `.env.local`。本任务新增轻量手解析加载器（不引依赖），供 Ark 客户端与 CLI 使用。

**Files:**

- Create: `apps/server/src/pipeline/env.ts`
- Test: `tests/unit/env.test.ts`
- Modify: `apps/server/src/pipeline/index.ts`（追加导出）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/env.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getArkApiKey, loadLocalEnv } from "../../apps/server/src/pipeline/env";
import { VideoForgeError } from "../../apps/server/src/shared/errors";

describe("环境变量加载", () => {
  const tempDirs: string[] = [];
  const originalKey = process.env.ARK_API_KEY;

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-env-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
    delete process.env.VF_TEST_KEY;
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("能从 .env.local 读取键值并注入 process.env", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".env.local"), '# 注释\nVF_TEST_KEY=hello\nQUOTED="a b"\n', "utf-8");
    loadLocalEnv(root);
    expect(process.env.VF_TEST_KEY).toBe("hello");
    expect(process.env.QUOTED).toBe("a b");
    delete process.env.QUOTED;
  });

  it("不覆盖已存在的环境变量", () => {
    const root = makeRoot();
    process.env.VF_TEST_KEY = "original";
    writeFileSync(join(root, ".env.local"), "VF_TEST_KEY=new\n", "utf-8");
    loadLocalEnv(root);
    expect(process.env.VF_TEST_KEY).toBe("original");
  });

  it(".env.local 不存在时静默跳过", () => {
    expect(() => loadLocalEnv(makeRoot())).not.toThrow();
  });

  it("getArkApiKey 在缺失时抛 CONFIG_INVALID", () => {
    delete process.env.ARK_API_KEY;
    expect(() => getArkApiKey(makeRoot())).toThrowError(VideoForgeError);
    expect(() => getArkApiKey(makeRoot())).toThrowError(/CONFIG_INVALID/);
  });

  it("getArkApiKey 优先读取 process.env", () => {
    process.env.ARK_API_KEY = "env-key";
    expect(getArkApiKey(makeRoot())).toBe("env-key");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/env.test.ts
```

预期：FAIL（模块 `pipeline/env` 不存在）。

- [ ] **Step 3: 最小实现**

```typescript
// apps/server/src/pipeline/env.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VideoForgeError } from "../shared/index.js";

/**
 * 解析仓库根目录的 .env.local 并注入 process.env；已存在的键不覆盖，文件缺失时静默跳过。
 * 注意：本函数与调用方均不得把读取到的值写入日志。
 */
export function loadLocalEnv(rootDir: string): void {
  const envPath = resolve(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * 获取火山方舟 API Key：先加载 .env.local，再读 ARK_API_KEY；缺失抛 CONFIG_INVALID。
 */
export function getArkApiKey(rootDir: string): string {
  loadLocalEnv(rootDir);
  const key = process.env.ARK_API_KEY?.trim();
  if (!key) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "缺少 ARK_API_KEY：请在环境变量或仓库根目录 .env.local 中配置",
    );
  }
  return key;
}
```

并在 `apps/server/src/pipeline/index.ts` 末尾追加：

```typescript
export * from "./env.js";
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
pnpm exec vitest run tests/unit/env.test.ts
```

预期：5 个用例全部 PASS。

---

## Task 2: 配置扩展 `engines.endpoints.ark`

把 Ark 端点与模型 ID 纳入配置体系（默认值进 default.yaml，密钥永远不进 yaml）。语言模型 ID 用占位值，待用户填到 `config/system.local.yaml`。

**Files:**

- Modify: `config/default.yaml`
- Modify: `config/system.local.example.yaml`
- Modify: `apps/server/src/pipeline/config.ts`
- Test: `tests/unit/config.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试（追加到 config.test.ts）**

```typescript
it("默认配置包含 ark 端点段且语言模型为占位", () => {
  const config = loadSystemConfig({ rootDir: resolve(process.cwd()) });
  expect(config.engines.endpoints.ark.base_url).toContain("/api/plan/v3");
  expect(config.engines.endpoints.ark.chat_model).toBe("PLEASE_FILL_CHAT_MODEL_ID");
});

it("ark 段的非法 base_url 会被校验拒绝", () => {
  expect(() =>
    loadSystemConfig({
      rootDir: resolve(process.cwd()),
      override: { engines: { endpoints: { ark: { base_url: "not-a-url" } } } },
    }),
  ).toThrowError(/CONFIG_INVALID/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/config.test.ts
```

预期：FAIL（`endpoints.ark` 不存在）。

- [ ] **Step 3: 修改 config.ts schema**

在 `engines` 的 zod 对象中追加：

```typescript
    endpoints: z
      .object({
        ark: z
          .object({
            // Agent Plan 专用基础地址（严禁 /api/v3）
            base_url: z.string().url(),
            // 语言模型 ID（占位，需在本机配置中填写）
            chat_model: z.string().trim().min(1),
            // 图片生成模型 ID
            image_model: z.string().trim().min(1),
            // TTS 说话人
            tts_speaker: z.string().trim().min(1),
            // TTS 服务地址（openspeech，独立于 ark base_url）
            tts_base_url: z.string().url(),
            // TTS 资源 ID（如 seed-tts-2.0）
            tts_resource_id: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
```

- [ ] **Step 4: 修改 config/default.yaml**

在 `engines:` 段内追加（每字段带规范注释）：

```yaml
endpoints:
  ark:
    # 火山方舟 Agent Plan 基础地址；必须使用 /api/plan/v3，改为 /api/v3 会产生额外费用
    base_url: "https://ark.cn-beijing.volces.com/api/plan/v3"
    # 语言模型 ID；占位值，必须在 config/system.local.yaml 中填写真实 ID 后方可生成文案
    chat_model: "PLEASE_FILL_CHAT_MODEL_ID"
    # 文生图模型 ID（doubao-seedream-5.0-pro）
    image_model: "doubao-seedream-5-0-pro-260628"
    # TTS 默认说话人；取值以火山控制台语音列表为准
    tts_speaker: "zh_female_vv_uranus_bigtts"
    # TTS 服务地址（openspeech，与 ark base_url 不同源）；Agent Plan 专用 /api/v3/plan/ 路径
    tts_base_url: "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional"
    # TTS 资源 ID，固定 seed-tts-2.0
    tts_resource_id: "seed-tts-2.0"
```

同步在 `config/system.local.example.yaml` 的 `engines:` 段追加相同结构（chat_model 保持占位并在注释中提示"在此填入真实模型 ID"）。

- [ ] **Step 5: 运行测试确认通过 + 全量回归**

```powershell
pnpm exec vitest run tests/unit/config.test.ts
pnpm test
```

预期：config 测试 PASS；全量无回归。

---

## Task 3: Ark HTTP 客户端模块

统一封装三个 Ark 能力：chat completions（文案/分镜）、images/generations（生图）、openspeech TTS（NDJSON 流式）。所有函数禁止记录 apiKey；HTTP/协议错误映射为 `ADAPTER_FAILED`，鉴权缺失映射 `CONFIG_INVALID`（由 Task 1 抛出）。

**Files:**

- Create: `apps/server/src/pipeline/ark-client.ts`
- Test: `tests/unit/ark-client.test.ts`
- Modify: `apps/server/src/pipeline/index.ts`（追加导出）

- [ ] **Step 1: 写失败测试（用 vi.stubGlobal mock fetch）**

```typescript
// tests/unit/ark-client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arkChatCompletion,
  arkGenerateImage,
  arkTtsToFile,
} from "../../apps/server/src/pipeline/ark-client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Ark 客户端", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("arkChatCompletion 发送正确请求并返回文本", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "文案内容" } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await arkChatCompletion({
      baseUrl: "https://ark.example/api/plan/v3",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "写文案" }],
    });
    expect(text).toBe("文案内容");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ark.example/api/plan/v3/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("arkChatCompletion 在非 2xx 时抛 ADAPTER_FAILED 且不泄露密钥", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 500 })));
    await expect(
      arkChatCompletion({ baseUrl: "https://x", apiKey: "SECRET-KEY", model: "m", messages: [] }),
    ).rejects.toThrowError(/ADAPTER_FAILED/);
    await expect(
      arkChatCompletion({ baseUrl: "https://x", apiKey: "SECRET-KEY", model: "m", messages: [] }),
    ).rejects.not.toThrowError(/SECRET-KEY/);
  });

  it("arkGenerateImage 以 b64_json 返回图片 Buffer", async () => {
    const png = Buffer.from("fake-png").toString("base64");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 }),
        ),
    );
    const buf = await arkGenerateImage({
      baseUrl: "https://x",
      apiKey: "k",
      model: "doubao-seedream-5-0-pro-260628",
      prompt: "科普插画",
      size: "2K",
    });
    expect(buf.toString()).toBe("fake-png");
  });

  it("arkTtsToFile 解析 NDJSON 流并拼接写盘", async () => {
    const chunk1 = Buffer.from("audio-1").toString("base64");
    const chunk2 = Buffer.from("audio-2").toString("base64");
    const ndjson =
      JSON.stringify({ data: chunk1 }) + "\n" + JSON.stringify({ data: chunk2 }) + "\n";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(ndjson, { status: 200, headers: { "Content-Type": "application/json" } }),
        ),
    );
    const dir = mkdtempSync(join(tmpdir(), "vf-tts-"));
    const out = join(dir, "voice 中文.mp3");
    try {
      await arkTtsToFile({
        ttsBaseUrl: "https://openspeech.example/api/v3/plan/tts/unidirectional",
        apiKey: "k",
        resourceId: "seed-tts-2.0",
        text: "你好",
        speaker: "spk",
        outputPath: out,
      });
      expect(readFileSync(out).toString()).toBe("audio-1audio-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arkTtsToFile 在音频块为空时抛 ADAPTER_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const dir = mkdtempSync(join(tmpdir(), "vf-tts-"));
    try {
      await expect(
        arkTtsToFile({
          ttsBaseUrl: "https://x",
          apiKey: "k",
          resourceId: "r",
          text: "你好",
          speaker: "s",
          outputPath: join(dir, "a.mp3"),
        }),
      ).rejects.toThrowError(/ADAPTER_FAILED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/ark-client.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```typescript
// apps/server/src/pipeline/ark-client.ts
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VideoForgeError } from "../shared/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 读取响应文本并把非 2xx 统一映射为 ADAPTER_FAILED；错误信息不携带请求头与密钥。
 */
async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new VideoForgeError(
    "ADAPTER_FAILED",
    `Ark ${action} 失败：HTTP ${response.status} ${body.slice(0, 300)}`,
  );
}

/**
 * 调用 Ark chat completions（OpenAI 兼容），返回首条消息文本。
 */
export async function arkChatCompletion(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: options.model, messages: options.messages }),
  });
  await ensureOk(response, "chat completions");
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new VideoForgeError("ADAPTER_FAILED", "Ark chat completions 返回为空");
  }
  return content;
}

/**
 * 调用 Ark images/generations，强制 b64_json 返回，解码为 Buffer。
 */
export async function arkGenerateImage(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
}): Promise<Buffer> {
  const response = await fetch(`${options.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      response_format: "b64_json",
    }),
  });
  await ensureOk(response, "images/generations");
  const json = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new VideoForgeError("ADAPTER_FAILED", "Ark images/generations 未返回 b64_json");
  }
  return Buffer.from(b64, "base64");
}

/**
 * 调用 openspeech TTS（Agent Plan 单向流式），逐行解析 NDJSON 中的 base64 音频块，
 * 拼接后写入 outputPath；无音频块时抛 ADAPTER_FAILED。
 */
export async function arkTtsToFile(options: {
  ttsBaseUrl: string;
  apiKey: string;
  resourceId: string;
  text: string;
  speaker: string;
  outputPath: string;
}): Promise<string> {
  const response = await fetch(options.ttsBaseUrl, {
    method: "POST",
    headers: {
      "X-Api-Key": options.apiKey,
      "X-Api-Resource-Id": options.resourceId,
      "X-Api-Request-Id": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      req_params: {
        text: options.text,
        speaker: options.speaker,
        audio_params: { format: "mp3", sample_rate: 24000 },
      },
    }),
  });
  await ensureOk(response, "tts");
  const raw = await response.text();
  const chunks: Buffer[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { data?: string };
    try {
      parsed = JSON.parse(trimmed) as { data?: string };
    } catch {
      throw new VideoForgeError("ADAPTER_FAILED", "TTS 响应包含无法解析的 NDJSON 行");
    }
    if (parsed.data) chunks.push(Buffer.from(parsed.data, "base64"));
  }
  if (chunks.length === 0) {
    throw new VideoForgeError("ADAPTER_FAILED", "TTS 响应不含音频数据");
  }
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, Buffer.concat(chunks));
  return options.outputPath;
}
```

并在 `apps/server/src/pipeline/index.ts` 末尾追加 `export * from "./ark-client.js";`。

- [ ] **Step 4: 运行测试确认通过 + 类型检查**

```powershell
pnpm exec vitest run tests/unit/ark-client.test.ts
pnpm --filter @videoforge/server build
```

预期：5 个用例 PASS；构建无类型错误。

---

## Task 4: 模板 SDK 支持图片场景

`SceneData` 当前只有 sceneId/title/narration，`renderMinimalScene` 无 `<img>`。skill2 的图片要进入逐帧渲染，必须扩展契约与模板。修改保持向后兼容（imagePath 可选），现有无测试引用这两个文件，不破坏回归。

**Files:**

- Modify: `apps/server/src/template-sdk/contracts.ts`
- Modify: `apps/server/src/template-sdk/minimal-scene.ts`
- Test: `tests/unit/minimal-scene.test.ts`（新增）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/minimal-scene.test.ts
import { describe, expect, it } from "vitest";
import { renderMinimalScene } from "../../apps/server/src/template-sdk/minimal-scene";
import { getProfile } from "../../apps/server/src/template-sdk/contracts";

const profile = getProfile("LANDSCAPE_1080P");

describe("最小场景模板", () => {
  it("无图片时不渲染 img 标签", () => {
    const html = renderMinimalScene({
      scene: { sceneId: "s1", title: "标题", narration: "旁白" },
      profile,
      timeMs: 0,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("标题");
  });

  it("有图片时渲染 img 且 src 为 file URL", () => {
    const html = renderMinimalScene({
      scene: {
        sceneId: "s1",
        title: "标题",
        narration: "旁白",
        imagePath: "D:\\data\\图片 1.png",
      },
      profile,
      timeMs: 0,
    });
    expect(html).toContain("<img");
    expect(html).toMatch(/src="file:\/\/\/D:.*%E5%9B%BE%E7%89%87/);
  });

  it("标题与旁白仍然 HTML 转义", () => {
    const html = renderMinimalScene({
      scene: { sceneId: "s1", title: "<b>x</b>", narration: "a&b" },
      profile,
      timeMs: 0,
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).not.toContain("<b>x</b>");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/minimal-scene.test.ts
```

预期：FAIL（`imagePath` 不存在 / img 未渲染）。

- [ ] **Step 3: 修改 contracts.ts**

```typescript
export interface SceneData {
  sceneId: string;
  title: string;
  narration: string;
  /** 可选：场景图片的绝对路径；存在时模板将其渲染为全屏底图 */
  imagePath?: string;
}
```

- [ ] **Step 4: 修改 minimal-scene.ts**

先读现有文件，保留既有结构（外层容器、进度条、标题/旁白区、HTML 转义函数），做两处增量修改：

1. 新增图片 URL 转换与渲染函数：

```typescript
import { pathToFileURL } from "node:url";

/**
 * 把本地图片绝对路径转为 file:// URL（自动处理 Windows 盘符、空格与中文）。
 */
function toImageUrl(imagePath: string): string {
  return pathToFileURL(imagePath).href;
}

/**
 * 渲染场景底图；imagePath 为空时返回空串。
 */
function renderSceneImage(imagePath: string | undefined, width: number, height: number): string {
  if (!imagePath) return "";
  return `<img src="${toImageUrl(imagePath)}" alt="" style="position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:cover;"/>`;
}
```

2. 在 `renderMinimalScene` 生成的 HTML 中，把 `${renderSceneImage(scene.imagePath, spec.width, spec.height)}` 作为最底层元素插入（标题/旁白/进度条保持在其上方，必要时给文字区加半透明底色保证可读性）。

注意：`renderBuild` 使用 `page.setContent`，相对路径不可解析，因此必须用 file:// 绝对 URL——这正是本任务不改动 render.ts 的原因。

- [ ] **Step 5: 运行测试确认通过 + 全量回归**

```powershell
pnpm exec vitest run tests/unit/minimal-scene.test.ts
pnpm test
```

预期：新测试 PASS；全量无回归。

---

## Task 5: 流水线辅助积木（时长探测 / 音频拼接 / 多场景渲染）

CLI 命令需要三块新积木：ffprobe 读音频时长（供分镜时间轴）、ffmpeg concat 拼接多段 TTS 音频（供 compose）、多场景连续帧渲染（现有 renderBuild 每场景帧号从 1 开始，直接循环会互相覆盖）。

**Files:**

- Create: `apps/server/src/pipeline/media.ts`
- Create: `apps/server/src/renderer/render-sequence.ts`
- Test: `tests/unit/media.test.ts`、`tests/unit/render-sequence.test.ts`
- Modify: `apps/server/src/pipeline/index.ts`、`apps/server/src/renderer/index.ts`（追加导出）

- [ ] **Step 1: 写失败测试 media.test.ts（mock child_process.spawn）**

```typescript
// tests/unit/media.test.ts
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { probeDurationMs } from "../../apps/server/src/pipeline/media";

/** 构造一个可按脚本输出 stdout 并以指定退出码结束的假子进程 */
function fakeProcess(stdout: string, code: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", code);
  });
  return proc;
}

describe("媒体工具", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("probeDurationMs 解析 ffprobe JSON 输出为毫秒", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess('{"format":{"duration":"3.520000"}}', 0) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-media-"));
    try {
      const ms = await probeDurationMs("ffprobe", join(dir, "中文 音频.mp3"));
      expect(ms).toBe(3520);
      const args = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
      expect(args[0]).toBe("ffprobe");
      expect(args[1]).toContain("-show_entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probeDurationMs 在输出非法时抛 ADAPTER_FAILED", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess("{}", 0) as never);
    await expect(probeDurationMs("ffprobe", "a.mp3")).rejects.toThrowError(/ADAPTER_FAILED/);
  });

  it("probeDurationMs 在非 0 退出码时抛 TOOL_UNAVAILABLE", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess("", 1) as never);
    await expect(probeDurationMs("ffprobe", "a.mp3")).rejects.toThrowError(/TOOL_UNAVAILABLE/);
  });
});
```

- [ ] **Step 2: 写失败测试 render-sequence.test.ts（mock renderBuild）**

```typescript
// tests/unit/render-sequence.test.ts
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/server/src/renderer/render", () => ({ renderBuild: vi.fn() }));

import { renderBuild } from "../../apps/server/src/renderer/render";
import { renderSceneSequence } from "../../apps/server/src/renderer/render-sequence";

describe("多场景连续渲染", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.mocked(renderBuild).mockReset();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("跨场景帧号连续递增", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-seq-"));
    dirs.push(root);
    vi.mocked(renderBuild).mockImplementation(async (opts: { buildRoot: string }) => {
      const frames = join(opts.buildRoot, "render", "landscape", "frames");
      mkdirSync(frames, { recursive: true });
      writeFileSync(join(frames, "00000001.png"), "a");
      writeFileSync(join(frames, "00000002.png"), "b");
      return join(opts.buildRoot, "render", "landscape", "render-report.json");
    });
    const result = await renderSceneSequence({
      buildRoot: root,
      profile: "LANDSCAPE_1080P",
      scenes: [
        { scene: { sceneId: "s1", title: "t1", narration: "n1" }, durationMs: 1000 },
        { scene: { sceneId: "s2", title: "t2", narration: "n2" }, durationMs: 1000 },
      ],
    });
    expect(result.frameCount).toBe(4);
    expect(readdirSync(result.framesDir).sort()).toEqual([
      "00000001.png",
      "00000002.png",
      "00000003.png",
      "00000004.png",
    ]);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/media.test.ts tests/unit/render-sequence.test.ts
```

- [ ] **Step 4: 实现 media.ts**

```typescript
// apps/server/src/pipeline/media.ts
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError } from "../shared/index.js";

/**
 * 以参数数组启动子进程并收集 stdout；非 0 退出码抛 TOOL_UNAVAILABLE（诊断含 stderr 截断，不含敏感信息）。
 */
function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      rejectPromise(new VideoForgeError("TOOL_UNAVAILABLE", `${command} 启动失败：${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        rejectPromise(
          new VideoForgeError(
            "TOOL_UNAVAILABLE",
            `${command} 退出码 ${code}：${stderr.slice(0, 300)}`,
          ),
        );
      }
    });
  });
}

/**
 * 用 ffprobe 读取媒体文件时长并返回毫秒；输出非法时抛 ADAPTER_FAILED。
 */
export async function probeDurationMs(ffprobePath: string, mediaPath: string): Promise<number> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    mediaPath,
  ]);
  let duration = Number.NaN;
  try {
    duration = Number.parseFloat(
      (JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration ?? "",
    );
  } catch {
    duration = Number.NaN;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoForgeError("ADAPTER_FAILED", `ffprobe 无法读取时长：${mediaPath}`);
  }
  return Math.round(duration * 1000);
}

/**
 * 转义 ffmpeg concat 列表中的路径（统一正斜杠，单引号按 ffmpeg 规则转义）。
 */
function escapeConcatPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

/**
 * 用 ffmpeg concat demuxer 顺序拼接多个同格式音频为单文件，返回输出路径。
 */
export async function concatAudioFiles(options: {
  ffmpegPath: string;
  inputs: string[];
  outputPath: string;
  workDir: string;
}): Promise<string> {
  if (options.inputs.length === 0) {
    throw new VideoForgeError("CONFIG_INVALID", "concatAudioFiles 需要至少一个输入音频");
  }
  mkdirSync(options.workDir, { recursive: true });
  const listPath = join(options.workDir, "concat-list.txt");
  const listContent = options.inputs.map((p) => `file '${escapeConcatPath(p)}'`).join("\n");
  writeFileSync(listPath, listContent, "utf-8");
  await runProcess(options.ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    options.outputPath,
  ]);
  return options.outputPath;
}
```

- [ ] **Step 5: 实现 render-sequence.ts**

```typescript
// apps/server/src/renderer/render-sequence.ts
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { renderBuild } from "./render.js";
import type { OutputProfile, SceneData } from "../template-sdk/index.js";

/**
 * 逐场景调用 renderBuild 渲染，并把各场景帧按顺序合并重编号到统一帧目录。
 * 说明：MVP 阶段每场景独立启动浏览器，优先保证正确性；返回统一帧目录与总帧数。
 */
export async function renderSceneSequence(options: {
  buildRoot: string;
  profile: OutputProfile;
  scenes: Array<{ scene: SceneData; durationMs: number }>;
  chromiumPath?: string;
}): Promise<{ framesDir: string; frameCount: number }> {
  const profileDir = options.profile === "LANDSCAPE_1080P" ? "landscape" : "portrait";
  const framesDir = join(options.buildRoot, "render", profileDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  let frameCount = 0;
  for (const { scene, durationMs } of options.scenes) {
    const sceneRoot = join(options.buildRoot, "render", profileDir, `tmp-${scene.sceneId}`);
    await renderBuild({
      buildRoot: sceneRoot,
      profile: options.profile,
      scene,
      totalMs: durationMs,
      chromiumPath: options.chromiumPath,
    });
    const sceneFrames = join(sceneRoot, "render", profileDir, "frames");
    for (const name of readdirSync(sceneFrames).sort()) {
      frameCount += 1;
      renameSync(
        join(sceneFrames, name),
        join(framesDir, `${String(frameCount).padStart(8, "0")}.png`),
      );
    }
  }
  return { framesDir, frameCount };
}
```

- [ ] **Step 6: 导出并回归**

`apps/server/src/pipeline/index.ts` 追加 `export * from "./media.js";`；`apps/server/src/renderer/index.ts`（若无此文件则按其现有导出文件为准）追加 `export * from "./render-sequence.js";`。

```powershell
pnpm exec vitest run tests/unit/media.test.ts tests/unit/render-sequence.test.ts
pnpm test
```

预期：新测试 PASS；全量无回归。

---

## Task 6: CLI 六个命令

skill 通过 CLI 调用本地能力。约定：**stdout 只输出机器可读 JSON 摘要**，诊断走 stderr；`--out` 指定落盘路径。中间契约是 `copy.json`（贯穿四个 skill 与两个基础命令）。

**Files:**

- Create: `apps/server/src/pipeline/copy-contract.ts`（契约 + zod 校验）
- Create: `apps/cli/src/args.ts`、`apps/cli/src/video-commands.ts`
- Modify: `apps/cli/src/index.ts`（路由）、`apps/server/src/pipeline/index.ts`（导出）
- Test: `tests/unit/copy-contract.test.ts`、`tests/unit/cli-video-commands.test.ts`

- [ ] **Step 1: 写失败测试 copy-contract.test.ts**

```typescript
// tests/unit/copy-contract.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCopyDoc, writeCopyDoc } from "../../apps/server/src/pipeline/copy-contract";

const sample = {
  topic: "黑洞",
  style: "科普",
  title: "黑洞是什么",
  scenes: [
    { sceneId: "s1", title: "引入", narration: "黑洞是……", imagePrompt: "深空中的黑洞插画" },
  ],
};

describe("copy.json 契约", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("写入后能在中文路径下读回且内容一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const path = join(dir, "文案 1.json");
    writeCopyDoc(path, sample);
    expect(readCopyDoc(path)).toEqual(sample);
  });

  it("缺少 scenes 的文件抛 ADAPTER_PROTOCOL_INVALID", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const path = join(dir, "bad.json");
    writeCopyDoc(path, sample);
    const bad = join(dir, "bad2.json");
    require("node:fs").writeFileSync(bad, JSON.stringify({ topic: "x" }), "utf-8");
    expect(() => readCopyDoc(bad)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });
});
```

- [ ] **Step 2: 写失败测试 cli-video-commands.test.ts**

```typescript
// tests/unit/cli-video-commands.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/server/src/pipeline/ark-client", () => ({
  arkChatCompletion: vi.fn(),
  arkGenerateImage: vi.fn(),
  arkTtsToFile: vi.fn(),
}));
vi.mock("../../apps/server/src/pipeline/env", () => ({ getArkApiKey: () => "test-key" }));

import { arkChatCompletion } from "../../apps/server/src/pipeline/ark-client";
import { parseArgs } from "../../apps/cli/src/args";
import { cmdCopyGen } from "../../apps/cli/src/video-commands";

describe("CLI 参数与 copy:gen", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.mocked(arkChatCompletion).mockReset();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("parseArgs 解析命令与 --key value 标志", () => {
    expect(parseArgs(["copy:gen", "--topic", "黑洞", "--style", "科普"])).toEqual({
      command: "copy:gen",
      flags: { topic: "黑洞", style: "科普" },
    });
  });

  it("cmdCopyGen 把模型 JSON 落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-cli-"));
    dirs.push(root);
    vi.mocked(arkChatCompletion).mockResolvedValue(
      JSON.stringify({
        title: "黑洞是什么",
        scenes: [{ sceneId: "s1", title: "引入", narration: "黑洞是……", imagePrompt: "深空黑洞" }],
      }),
    );
    const out = join(root, "copy.json");
    await cmdCopyGen(root, { topic: "黑洞", style: "科普", out });
    const doc = JSON.parse(readFileSync(out, "utf-8"));
    expect(doc.topic).toBe("黑洞");
    expect(doc.scenes).toHaveLength(1);
  });

  it("模型返回非法 JSON 时抛 ADAPTER_PROTOCOL_INVALID", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-cli-"));
    dirs.push(root);
    vi.mocked(arkChatCompletion).mockResolvedValue("这不是 JSON");
    await expect(
      cmdCopyGen(root, { topic: "x", style: "科普", out: join(root, "c.json") }),
    ).rejects.toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });
});
```

注意：cmdCopyGen 内部会 `loadSystemConfig({ rootDir })`，临时目录没有 default.yaml。实现时让命令函数接受可选的 `configOverride`（测试传入最小 ark 段），或在测试中往临时目录写最小 default.yaml——**采用后者**，保持命令签名干净。

- [ ] **Step 3: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/copy-contract.test.ts tests/unit/cli-video-commands.test.ts
```

- [ ] **Step 4: 实现 copy-contract.ts**

```typescript
// apps/server/src/pipeline/copy-contract.ts
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { VideoForgeError } from "../shared/index.js";

export const copySceneSchema = z.object({
  sceneId: z.string().min(1),
  title: z.string(),
  narration: z.string().min(1),
  imagePrompt: z.string().min(1),
  imagePath: z.string().optional(),
  audioPath: z.string().optional(),
});

export const copyDocSchema = z.object({
  topic: z.string().min(1),
  style: z.string().min(1),
  title: z.string().min(1),
  scenes: z.array(copySceneSchema).min(1),
});

export type CopyDoc = z.infer<typeof copyDocSchema>;

/**
 * 读取并校验 copy.json；结构非法时抛 ADAPTER_PROTOCOL_INVALID。
 */
export function readCopyDoc(path: string): CopyDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  const result = copyDocSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 以 UTF-8、2 空格缩进写 copy.json。
 */
export function writeCopyDoc(path: string, doc: CopyDoc): void {
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
}
```

- [ ] **Step 5: 实现 args.ts**

```typescript
// apps/cli/src/args.ts
/**
 * 解析 `<command> --key value ...` 形式的 argv；布尔标志不支持，未知参数原样忽略。
 */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("--") && i + 1 < rest.length) {
      flags[token.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return { command, flags };
}

/**
 * 取必需标志；缺失时抛 CONFIG_INVALID。
 */
export function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim();
  if (!value) {
    throw new Error(`CONFIG_INVALID: 缺少必需参数 --${name}`);
  }
  return value;
}
```

- [ ] **Step 6: 实现 video-commands.ts**

````typescript
// apps/cli/src/video-commands.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  arkChatCompletion,
  arkGenerateImage,
  arkTtsToFile,
  buildTimeline,
  composeVideo,
  concatAudioFiles,
  copyDocSchema,
  getArkApiKey,
  loadSystemConfig,
  probeDurationMs,
  readCopyDoc,
  writeCopyDoc,
  VideoForgeError,
  type CopyDoc,
} from "@videoforge/server/src/pipeline/index.js";
import { renderSceneSequence } from "@videoforge/server/src/renderer/render-sequence.js";
import { getProfile, type OutputProfile } from "@videoforge/server/src/template-sdk/index.js";
import { requireFlag } from "./args.js";

/** 文案生成系统提示词：要求模型只输出符合 copy.json 契约的严格 JSON */
const COPY_SYSTEM_PROMPT = [
  "你是科普/历史短视频编剧。只输出严格 JSON，不要输出任何其他文字。结构：",
  '{"title":"视频标题","scenes":[{"sceneId":"s1","title":"场景标题","narration":"口播文案（60-120字）","imagePrompt":"文生图提示词"}]}',
  "要求：4-8 个场景；sceneId 依次为 s1、s2…；narration 为中文口播；imagePrompt 描述具体画面。",
].join("\n");

/** 从模型输出解析文案文档（容忍 ```json 围栏），结构非法抛 ADAPTER_PROTOCOL_INVALID */
function parseCopyJson(text: string, topic: string, style: string): CopyDoc {
  const cleaned = text
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "文案模型未输出合法 JSON");
  }
  const result = copyDocSchema.safeParse({ topic, style, ...(raw as Record<string, unknown>) });
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `文案 JSON 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

/** 加载配置并取 ark 段；chat_model 为占位值时给出明确报错 */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  const ark = config.engines.endpoints.ark;
  return { config, apiKey, ark };
}

/** copy:gen：主题 → copy.json */
export async function cmdCopyGen(rootDir: string, flags: Record<string, string>): Promise<void> {
  const topic = requireFlag(flags, "topic");
  const style = flags.style?.trim() || "科普";
  const out = requireFlag(flags, "out");
  const { apiKey, ark } = loadArk(rootDir);
  if (ark.chat_model === "PLEASE_FILL_CHAT_MODEL_ID") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "请先在 config/system.local.yaml 填写 engines.endpoints.ark.chat_model",
    );
  }
  const text = await arkChatCompletion({
    baseUrl: ark.base_url,
    apiKey,
    model: ark.chat_model,
    messages: [
      { role: "system", content: COPY_SYSTEM_PROMPT },
      { role: "user", content: `主题：${topic}\n风格：${style}` },
    ],
  });
  const doc = parseCopyJson(text, topic, style);
  writeCopyDoc(out, doc);
  process.stdout.write(JSON.stringify({ out, scenes: doc.scenes.length }) + "\n");
}

/** image:gen：为每个场景生成图片并回填 imagePath（默认覆盖写回 --copy 文件） */
export async function cmdImageGen(rootDir: string, flags: Record<string, string>): Promise<void> {
  const copyPath = requireFlag(flags, "copy");
  const doc = readCopyDoc(copyPath);
  const { apiKey, ark } = loadArk(rootDir);
  const imagesDir = join(dirname(copyPath), "images");
  mkdirSync(imagesDir, { recursive: true });
  for (const scene of doc.scenes) {
    const buf = await arkGenerateImage({
      baseUrl: ark.base_url,
      apiKey,
      model: ark.image_model,
      prompt: scene.imagePrompt,
      size: "2K",
    });
    const imagePath = join(imagesDir, `${scene.sceneId}.png`);
    writeFileSync(imagePath, buf);
    scene.imagePath = imagePath;
  }
  writeCopyDoc(flags.out ?? copyPath, doc);
  process.stdout.write(JSON.stringify({ images: doc.scenes.map((s) => s.imagePath) }) + "\n");
}

/** tts:gen：为每个场景生成语音并回填 audioPath；--speaker 可覆盖配置默认值 */
export async function cmdTtsGen(rootDir: string, flags: Record<string, string>): Promise<void> {
  const copyPath = requireFlag(flags, "copy");
  const doc = readCopyDoc(copyPath);
  const { apiKey, ark } = loadArk(rootDir);
  const speaker = flags.speaker?.trim() || ark.tts_speaker;
  const audioDir = join(dirname(copyPath), "audio");
  for (const scene of doc.scenes) {
    scene.audioPath = await arkTtsToFile({
      ttsBaseUrl: ark.tts_base_url,
      apiKey,
      resourceId: ark.tts_resource_id,
      text: scene.narration,
      speaker,
      outputPath: join(audioDir, `${scene.sceneId}.mp3`),
    });
  }
  writeCopyDoc(flags.out ?? copyPath, doc);
  process.stdout.write(JSON.stringify({ audios: doc.scenes.map((s) => s.audioPath) }) + "\n");
}

/** storyboard:gen：用 ffprobe 读取各场景音频时长，生成 timeline.json（尾帧停顿 500ms） */
export async function cmdStoryboardGen(
  rootDir: string,
  flags: Record<string, string>,
): Promise<void> {
  const copyPath = requireFlag(flags, "copy");
  const out = requireFlag(flags, "out");
  const doc = readCopyDoc(copyPath);
  const { config } = loadArk(rootDir);
  const durations = [];
  for (const scene of doc.scenes) {
    if (!scene.audioPath) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `场景 ${scene.sceneId} 缺少 audioPath，请先运行 tts:gen`,
      );
    }
    durations.push({
      sceneId: scene.sceneId,
      durationMs: await probeDurationMs(config.tools.ffprobe_path, scene.audioPath),
    });
  }
  const timeline = buildTimeline(durations, 500);
  writeFileSync(out, JSON.stringify(timeline, null, 2), "utf-8");
  process.stdout.write(JSON.stringify({ out, totalMs: timeline.totalMs }) + "\n");
}

/** render：按时间轴逐场景渲染连续帧 */
export async function cmdRender(rootDir: string, flags: Record<string, string>): Promise<void> {
  const copyPath = requireFlag(flags, "copy");
  const timelinePath = requireFlag(flags, "timeline");
  const profile = (flags.profile?.trim() || "LANDSCAPE_1080P") as OutputProfile;
  const doc = readCopyDoc(copyPath);
  const timeline = JSON.parse(readFileSync(timelinePath, "utf-8")) as {
    entries: Array<{ sceneId: string; startMs: number; endMs: number }>;
  };
  const { config } = loadArk(rootDir);
  const buildRoot = flags["build-root"]?.trim() || join(dirname(copyPath), "build");
  const scenes = timeline.entries.map((entry) => {
    const scene = doc.scenes.find((s) => s.sceneId === entry.sceneId);
    if (!scene) {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `timeline 引用了未知场景 ${entry.sceneId}`,
      );
    }
    return {
      scene: {
        sceneId: scene.sceneId,
        title: scene.title,
        narration: scene.narration,
        imagePath: scene.imagePath,
      },
      durationMs: entry.endMs - entry.startMs,
    };
  });
  const result = await renderSceneSequence({
    buildRoot,
    profile,
    scenes,
    chromiumPath: config.tools.chromium_path || undefined,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

/** compose：拼接场景音频并与帧序列合成最终 mp4 */
export async function cmdCompose(rootDir: string, flags: Record<string, string>): Promise<void> {
  const copyPath = requireFlag(flags, "copy");
  const out = requireFlag(flags, "out");
  const profile = (flags.profile?.trim() || "LANDSCAPE_1080P") as OutputProfile;
  const profileDir = profile === "LANDSCAPE_1080P" ? "landscape" : "portrait";
  const doc = readCopyDoc(copyPath);
  const { config } = loadArk(rootDir);
  const buildRoot = flags["build-root"]?.trim() || join(dirname(copyPath), "build");
  const composeDir = join(buildRoot, "compose", profileDir);
  const inputs = doc.scenes.map((s) => {
    if (!s.audioPath)
      throw new VideoForgeError("CONFIG_INVALID", `场景 ${s.sceneId} 缺少 audioPath`);
    return s.audioPath;
  });
  const audioAll = await concatAudioFiles({
    ffmpegPath: config.tools.ffmpeg_path,
    inputs,
    outputPath: join(composeDir, "voice-all.mp3"),
    workDir: composeDir,
  });
  const output = await composeVideo({
    ffmpegPath: config.tools.ffmpeg_path,
    framesPattern: join(buildRoot, "render", profileDir, "frames", "%08d.png"),
    audioPath: audioAll,
    outputPath: out,
    fps: getProfile(profile).fps,
    logPath: join(composeDir, "ffmpeg.log"),
  });
  process.stdout.write(JSON.stringify({ output }) + "\n");
}
````

实现提示：timeline.json 读取后建议用局部 zod schema 校验 entries 结构（sceneId 为 string、startMs/endMs 为 number），非法时抛 ADAPTER_PROTOCOL_INVALID。

- [ ] **Step 7: 扩展 index.ts 路由**

```typescript
// apps/cli/src/index.ts（保留 doctor 分支，新增分发）
import { parseArgs } from "./args.js";
import {
  cmdCompose,
  cmdCopyGen,
  cmdImageGen,
  cmdRender,
  cmdStoryboardGen,
  cmdTtsGen,
} from "./video-commands.js";

const { command, flags } = parseArgs(process.argv.slice(2));
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

const handlers: Record<string, (root: string, f: Record<string, string>) => Promise<void>> = {
  "copy:gen": cmdCopyGen,
  "image:gen": cmdImageGen,
  "tts:gen": cmdTtsGen,
  "storyboard:gen": cmdStoryboardGen,
  render: cmdRender,
  compose: cmdCompose,
};

if (command === "doctor") {
  await runDoctor(projectRoot);
} else if (handlers[command]) {
  try {
    await handlers[command](projectRoot, flags);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`未知命令：${command}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 8: 验证 + 全量回归**

```powershell
pnpm exec vitest run tests/unit/copy-contract.test.ts tests/unit/cli-video-commands.test.ts
pnpm --filter @videoforge/cli build
pnpm test
```

预期：新测试 PASS；CLI 构建通过；全量无回归。

---

## Task 7: 四个 Trae skill

按 Trae skill 规范在 `.trae/skills/` 下建四个目录，每个含 SKILL.md。skill 是薄封装：指导 harness 里的 agent 调用 CLI、校验产物、串联下一步。render/compose 基础命令的调用说明编入 vf-storyboard（紧跟时间轴之后执行），保证 4 个 skill 覆盖完整闭环。

**Files:**

- Create: `.trae/skills/vf-copywriter/SKILL.md`
- Create: `.trae/skills/vf-image-gen/SKILL.md`
- Create: `.trae/skills/vf-tts/SKILL.md`
- Create: `.trae/skills/vf-storyboard/SKILL.md`

- [ ] **Step 1: vf-copywriter/SKILL.md**

````markdown
---
name: vf-copywriter
description: 输入主题生成科普/历史短视频文案（分镜 JSON）。当用户给出视频主题、需要生成口播文案与分镜时调用。
---

# 文案生成

## 前置条件

- 仓库根目录 `.env.local` 已配置 `ARK_API_KEY`（或同名环境变量）。
- `config/system.local.yaml` 已填写 `engines.endpoints.ark.chat_model`（语言模型 ID）。

## 调用

```powershell
pnpm --filter @videoforge/cli start copy:gen --topic "<主题>" --style "<科普|历史>" --out "<工作目录>\copy.json"
```
````

- stdout 输出 JSON 摘要 `{"out": "...", "scenes": N}`；诊断在 stderr。
- 需要联网检索资料时，先使用 harness 的搜索工具（如豆包搜索）整理要点，再把要点并入 `--topic`。

## 产物

`copy.json`：`{topic, style, title, scenes: [{sceneId, title, narration, imagePrompt}]}`。

## 失败处理

- `CONFIG_INVALID`：检查 ARK_API_KEY 与 chat_model 配置。
- `ADAPTER_PROTOCOL_INVALID`：模型未输出合法 JSON，重试或在 topic 中补充"严格 JSON"要求。
- `ADAPTER_FAILED`：Ark 服务异常，把 stderr 信息反馈给用户。

## 下一步

审核 copy.json（可向用户展示文案确认），然后调用 vf-image-gen。

````

- [ ] **Step 2: vf-image-gen/SKILL.md**

```markdown
---
name: vf-image-gen
description: 根据 copy.json 中每个分镜的 imagePrompt 生成场景图片。当文案已生成、需要为分镜配图时调用。
---

# 分镜配图

## 前置条件
- 已完成 vf-copywriter，目标 `copy.json` 存在且含 scenes。
- `.env.local` 已配置 `ARK_API_KEY`。

## 调用

```powershell
pnpm --filter @videoforge/cli start image:gen --copy "<工作目录>\copy.json"
````

- 逐场景调用 Ark 文生图（doubao-seedream-5.0-pro，2K），图片写入 `<工作目录>\images\<sceneId>.png`。
- 成功后把 `imagePath` 回填进 copy.json（可用 `--out` 另存）。

## 产物

- `images\*.png`；更新后的 copy.json（scenes 含 imagePath）。

## 失败处理

- `ADAPTER_FAILED`：单场景生图失败会中断流程；可检查 prompt 是否触发内容限制，调整 copy.json 中该场景 imagePrompt 后重跑（已生成的图片会从头重生成，如需跳过请手工保留并重排）。

## 下一步

调用 vf-tts。

````

- [ ] **Step 3: vf-tts/SKILL.md**

```markdown
---
name: vf-tts
description: 根据 copy.json 中每个分镜的 narration 生成口播语音（mp3）。当文案与图片就绪、需要配音时调用。
---

# 语音合成

## 前置条件
- 目标 `copy.json` 存在且 scenes 含 narration。
- `.env.local` 已配置 `ARK_API_KEY`。

## 调用

```powershell
pnpm --filter @videoforge/cli start tts:gen --copy "<工作目录>\copy.json" [--speaker "<音色>"]
````

- 使用 seed-tts-2.0；默认音色取配置 `engines.endpoints.ark.tts_speaker`，`--speaker` 可覆盖。
- 音频写入 `<工作目录>\audio\<sceneId>.mp3`，并把 `audioPath` 回填 copy.json。

## 产物

- `audio\*.mp3`；更新后的 copy.json（scenes 含 audioPath）。

## 失败处理

- `ADAPTER_FAILED`：TTS 服务异常或音色非法；确认 speaker 在火山控制台语音列表中存在。

## 下一步

调用 vf-storyboard 生成时间轴并完成渲染合成。

````

- [ ] **Step 4: vf-storyboard/SKILL.md**

```markdown
---
name: vf-storyboard
description: 根据 copy.json 的语音时长生成分镜时间轴，并驱动逐帧渲染与视频合成，产出最终 mp4。当配音完成、需要出片时调用。
---

# 时间轴与出片

## 前置条件
- copy.json 的每个 scene 都含 audioPath（已完成 vf-tts）。
- 本机 ffmpeg/ffprobe 可用（`pnpm run doctor` 验证）；渲染需要 Chromium（config tools.chromium_path 或系统默认）。

## 步骤 1：生成时间轴

```powershell
pnpm --filter @videoforge/cli start storyboard:gen --copy "<工作目录>\copy.json" --out "<工作目录>\timeline.json"
````

用 ffprobe 读取各场景音频真实时长，输出 `{entries: [{sceneId, startMs, endMs, durationMs}], totalMs}`。

## 步骤 2：逐帧渲染（基础能力）

```powershell
pnpm --filter @videoforge/cli start render --copy "<工作目录>\copy.json" --timeline "<工作目录>\timeline.json" --profile LANDSCAPE_1080P
```

- 帧输出到 `<工作目录>\build\render\<landscape|portrait>\frames\`；stdout 返回 `{framesDir, frameCount}`。
- 竖屏用 `--profile PORTRAIT_1080P`。

## 步骤 3：合成视频（基础能力）

```powershell
pnpm --filter @videoforge/cli start compose --copy "<工作目录>\copy.json" --out "<工作目录>\final.mp4" --profile LANDSCAPE_1080P
```

- 自动拼接场景音频并与帧序列合成；stdout 返回 `{"output": "..."}`。

## 失败处理

- `CONFIG_INVALID`：缺 audioPath（先跑 vf-tts）或 timeline 引用未知场景。
- `TOOL_UNAVAILABLE`：ffmpeg/ffprobe/Chromium 不可用，按 `pnpm run doctor` 提示修复。

## 产物

`<工作目录>\final.mp4`。可向用户展示路径，并提示在 Web 监控站查看物料。

````

- [ ] **Step 5: 验证**

```powershell
pnpm run doctor
````

并人工检查四个 SKILL.md 的 frontmatter 含 name/description（description < 200 字符）、命令在仓库根目录可执行（`--help` 不需要，直接跑一次 copy:gen 缺参数验证报错文案）。

---

## Task 8: Web 监控扩展（工作区物料 + 产物播放）

harness 架构下 CLI 产物在文件系统。约定 skill 工作目录位于 `<storage_root>/workspace/<日期-主题>/`（已写入各 SKILL.md 的路径示例说明，Task 7 的 `<工作目录>` 即此约定），server 提供只读媒体 API，Web 展示工作区列表与详情。

**Files:**

- Modify: `apps/server/src/app.ts`（新增两个只读路由）
- Create: `apps/web/src/views/WorkspaceListView.vue`、`apps/web/src/views/WorkspaceDetailView.vue`
- Modify: `apps/web/src/router`（按现有路由文件实际路径）与导航
- Test: `tests/unit/workspace-api.test.ts`（新增）、前端组件测试

- [ ] **Step 1: 写失败测试 workspace-api.test.ts**

```typescript
// tests/unit/workspace-api.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// createApp 的导入路径与构造方式以现有 app 测试为准
import { createApp } from "../../apps/server/src/app";

describe("工作区监控 API", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("GET /api/workspaces 列出工作区及产物状态", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ws-"));
    dirs.push(root);
    const ws = join(root, "workspace", "2026-10-08-黑洞");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "copy.json"), "{}", "utf-8");
    const app = await createApp({ storageRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workspaces: Array<{ name: string; hasCopy: boolean; hasVideo: boolean }>;
    };
    expect(body.workspaces[0]).toMatchObject({
      name: "2026-10-08-黑洞",
      hasCopy: true,
      hasVideo: false,
    });
    await app.close();
  });

  it("GET /api/media 拒绝越界路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ws-"));
    dirs.push(root);
    const app = await createApp({ storageRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/media/..%2F..%2Fsecret.txt" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/media 能读取 workspace 内的图片", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ws-"));
    dirs.push(root);
    mkdirSync(join(root, "workspace", "w1", "images"), { recursive: true });
    writeFileSync(join(root, "workspace", "w1", "images", "s1.png"), Buffer.from([0x89, 0x50]));
    const app = await createApp({ storageRoot: root });
    const res = await app.inject({
      method: "GET",
      url: `/api/media/${encodeURIComponent("workspace/w1/images/s1.png").replace(/%2F/g, "/")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    await app.close();
  });
});
```

注意：`createApp` 当前若不接收 `storageRoot` 参数，本任务需给它加可选参数（默认仍从配置读取），属向后兼容扩展。

- [ ] **Step 2: 运行测试确认失败**

```powershell
pnpm exec vitest run tests/unit/workspace-api.test.ts
```

- [ ] **Step 3: 服务端实现**

在 `app.ts` 新增（均在现有 createApp 内，保持 127.0.0.1 监听边界不变）：

```typescript
// 媒体扩展名到 content-type 的映射；未匹配一律 application/octet-stream
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

/** 注册工作区监控只读路由：列表 + 受限媒体读取（限 storageRoot 内） */
function registerWorkspaceRoutes(app: FastifyInstance, storageRoot: string): void {
  app.get("/api/workspaces", async () => {
    const wsRoot = join(storageRoot, "workspace");
    if (!existsSync(wsRoot)) return { workspaces: [] };
    const workspaces = readdirSync(wsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(wsRoot, d.name);
        return {
          name: d.name,
          hasCopy: existsSync(join(dir, "copy.json")),
          hasVideo: existsSync(join(dir, "final.mp4")),
        };
      });
    return { workspaces };
  });

  app.get("/api/media/*", async (request, reply) => {
    const rel = (request.params as { "*": string })["*"];
    let abs: string;
    try {
      abs = resolveArtifactPath(storageRoot, rel); // 复用 path-safety，越界抛 PATH_OUTSIDE_STORAGE
    } catch {
      return reply.code(400).send({ error: "PATH_OUTSIDE_STORAGE" });
    }
    if (!existsSync(abs)) return reply.code(404).send({ error: "NOT_FOUND" });
    reply.header(
      "content-type",
      MEDIA_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream",
    );
    return reply.send(readFileSync(abs));
  });
}
```

- [ ] **Step 4: 前端页面**

- `WorkspaceListView.vue`：调 `GET /api/workspaces`（相对路径，遵守不改 api.ts/sse.ts 的约定），表格展示工作区名/文案状态/视频状态，点击进详情；键盘可达。
- `WorkspaceDetailView.vue`：路由参数带工作区名；加载 `copy.json`（经 `/api/media/workspace/<名>/copy.json`）展示分镜列表；每个分镜渲染图片（`/api/media/workspace/<名>/images/<sceneId>.png`）、音频 `<audio controls>`；存在 final.mp4 时渲染 `<video controls>`。
- 样式沿用 global.css 与 scoped 样式；窄屏（约 390px）下图片墙单列。

- [ ] **Step 5: 验证**

```powershell
pnpm exec vitest run tests/unit/workspace-api.test.ts
pnpm --filter @videoforge/web build
pnpm test
```

并启动 server + web 在浏览器人工验证：工作区列表、图片/音频/视频播放、窄屏布局（按 AGENTS.md 前端约定）。

---

## Task 9: 端到端冒烟 + 文档

**Files:**

- Modify: `docs/guides/developer-guide.md`、`docs/guides/operator-guide.md`

- [ ] **Step 1: 真实冒烟（手动执行，需真实 ARK_API_KEY 与 chat_model）**

```powershell
# 在 config/system.local.yaml 填好 chat_model、.env.local 填好 ARK_API_KEY 后：
$ws = "storage\workspace\冒烟-黑洞"
pnpm --filter @videoforge/cli start copy:gen --topic "黑洞是什么" --style "科普" --out "$ws\copy.json"
pnpm --filter @videoforge/cli start image:gen --copy "$ws\copy.json"
pnpm --filter @videoforge/cli start tts:gen --copy "$ws\copy.json"
pnpm --filter @videoforge/cli start storyboard:gen --copy "$ws\copy.json" --out "$ws\timeline.json"
pnpm --filter @videoforge/cli start render --copy "$ws\copy.json" --timeline "$ws\timeline.json"
pnpm --filter @videoforge/cli start compose --copy "$ws\copy.json" --out "$ws\final.mp4"
```

验收：final.mp4 可播放、音画同步、时长 ≈ timeline.totalMs；Web 工作区页能看到该工作区并播放视频。

- [ ] **Step 2: 更新开发者指南**

新增小节：环境变量（ARK_API_KEY/.env.local）、Ark 端点配置（plan 路径警告）、CLI 六命令参考、copy.json 契约、四个 skill 目录。

- [ ] **Step 3: 更新操作者指南**

新增"从主题到成片"操作流：四个 skill 的调用顺序、审核点（文案确认、图片确认）、常见错误码对照表。明确标注：worker 持续调度与审核闭环仍未实现（与 AGENTS.md 已知边界一致）。

- [ ] **Step 4: 最终回归**

```powershell
pnpm test
pnpm build
```

---

## Self-Review

- **Spec coverage**：skill1→Task 6 cmdCopyGen+Task 7 vf-copywriter；skill2→cmdImageGen+Task 4 模板图片+vf-image-gen；skill3→cmdTtsGen+vf-tts；skill4→cmdStoryboardGen+vf-storyboard；基础能力→cmdRender/cmdCompose（Task 5 积木）；Web 监控→Task 8；Ark 供给→Task 1-3。
- **Placeholder scan**：chat_model 为有意配置占位（运行时显式报错引导）；无代码占位符。
- **一致性**：所有新模块经 `pipeline/index.js` / 子路径导出；测试 import 无 `.js` 扩展名；错误码全部复用现有 VideoForgeErrorCode。

## Execution Handoff

计划已完成，请选择执行方式：

**1. Subagent-Driven（推荐）**——每个 Task 派一个子代理执行，任务间 review，上下文保持干净。
**2. Inline Execution**——在当前会话按 Task 顺序逐批执行。
