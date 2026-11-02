import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arkChatCompletion,
  arkGenerateImage,
  arkTtsToFile,
} from "../../packages/pipeline/src/ark-client";
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

  it("arkTtsToFile 解析 NDJSON 流并拼接写盘（20000000 结束码视为成功）", async () => {
    const chunk1 = Buffer.from("audio-1").toString("base64");
    const chunk2 = Buffer.from("audio-2").toString("base64");
    const ndjson =
      JSON.stringify({ data: chunk1 }) +
      "\n" +
      JSON.stringify({ data: chunk2 }) +
      "\n" +
      // openspeech 以 code=20000000 标记「音频合成结束」，属于成功码而非错误
      JSON.stringify({ code: 20000000, message: "ok" }) +
      "\n";
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

  it("arkTtsToFile 在 HTTP 200 但行内 code 非成功码时透出真实错误", async () => {
    // 复现 openspeech 音色不匹配：HTTP 200，错误只放在 code/message 中
    const errorLine = JSON.stringify({
      reqid: "",
      code: 55000000,
      message: "resource ID is mismatched with speaker related resource",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(errorLine, { status: 200 })));
    const dir = mkdtempSync(join(tmpdir(), "vf-tts-"));
    try {
      await expect(
        arkTtsToFile({
          ttsBaseUrl: "https://x",
          apiKey: "k",
          resourceId: "r",
          text: "你好",
          speaker: "bad",
          outputPath: join(dir, "a.mp3"),
        }),
      ).rejects.toThrowError(/55000000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
