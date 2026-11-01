import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));
// 部分 mock：仅替换渲染执行函数，sceneFrameCount 等纯函数保留真实实现
vi.mock("../../packages/renderer/src/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/renderer/src/render")>();
  return { ...actual, renderSceneFrames: vi.fn() };
});

import { chromium } from "playwright";
import { renderSceneFrames } from "../../packages/renderer/src/render";
import { renderSceneSequence } from "../../packages/renderer/src/render-sequence";

/** 构造假浏览器实例：newPage 返回带 close 计数的占位页面，close 计数供断言 */
function fakeBrowser() {
  return {
    newPage: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    close: vi.fn(async () => undefined),
  };
}

describe("多场景连续渲染", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.mocked(renderSceneFrames).mockReset();
    vi.mocked(chromium.launch).mockReset();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("单浏览器复用且跨场景帧号连续递增", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-seq-"));
    dirs.push(root);
    const browser = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);
    // mock 渲染：每场景写 2 帧（帧号由 firstFrame 起编），返回帧数
    vi.mocked(renderSceneFrames).mockImplementation(
      async (opts: { framesDir: string; firstFrame: number }) => {
        mkdirSync(opts.framesDir, { recursive: true });
        writeFileSync(join(opts.framesDir, `${String(opts.firstFrame).padStart(8, "0")}.jpg`), "a");
        writeFileSync(
          join(opts.framesDir, `${String(opts.firstFrame + 1).padStart(8, "0")}.jpg`),
          "b",
        );
        return 2;
      },
    );
    const result = await renderSceneSequence({
      buildRoot: root,
      profile: "LANDSCAPE_1080P",
      scenes: [
        { scene: { sceneId: "s1", title: "t1", narration: "n1" }, durationMs: 1000 },
        { scene: { sceneId: "s2", title: "t2", narration: "n2" }, durationMs: 1000 },
      ],
    });
    expect(result.frameCount).toBe(60);
    expect(readdirSync(result.framesDir).sort()).toEqual([
      "00000001.jpg",
      "00000002.jpg",
      "00000031.jpg",
      "00000032.jpg",
    ]);
    // 浏览器只启动一次且最终关闭；单 page 串行；第二场景从第 31 帧起编
    expect(vi.mocked(chromium.launch)).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderSceneFrames).mock.calls[1]?.[0]).toMatchObject({ firstFrame: 31 });
  });

  it("workers=2 时按 round-robin 分片并行且帧号仍全局连续", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-seq-"));
    dirs.push(root);
    const browser = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);
    // 每个场景固定 30 帧（1s @30fps），直接返回按 same 规则计算的帧数
    vi.mocked(renderSceneFrames).mockImplementation(async () => 30);
    const scenes = ["s1", "s2", "s3"].map((sceneId) => ({
      scene: { sceneId, title: sceneId, narration: "n" },
      durationMs: 1000,
    }));
    const onSceneRendered = vi.fn();
    const result = await renderSceneSequence({
      buildRoot: root,
      profile: "LANDSCAPE_1080P",
      scenes,
      workers: 2,
      onSceneRendered,
    });
    expect(result.frameCount).toBe(90);
    // 两个 page 并行；分片 [s1,s3] 与 [s2]，帧号起点分别为 1/61 与 31
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    const starts = vi
      .mocked(renderSceneFrames)
      .mock.calls.map((call) => call[0] as { scene: { sceneId: string }; firstFrame: number })
      .map(({ scene, firstFrame }) => `${scene.sceneId}@${firstFrame}`)
      .sort();
    expect(starts).toEqual(["s1@1", "s2@31", "s3@61"]);
    // 场景级完成回调：每场景一次，携带帧数、帧号起点与耗时
    expect(onSceneRendered).toHaveBeenCalledTimes(3);
    const callbacks = onSceneRendered.mock.calls
      .map(
        ([info]) =>
          info as { sceneId: string; frames: number; firstFrame: number; durationMs: number },
      )
      .map((info) => `${info.sceneId}:${info.frames}@${info.firstFrame}`)
      .sort();
    expect(callbacks).toEqual(["s1:30@1", "s2:30@31", "s3:30@61"]);
  });

  it("Chromium 启动失败时抛 TOOL_UNAVAILABLE", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-seq-"));
    dirs.push(root);
    vi.mocked(chromium.launch).mockRejectedValue(new Error("spawn ENOENT"));
    await expect(
      renderSceneSequence({ buildRoot: root, profile: "LANDSCAPE_1080P", scenes: [] }),
    ).rejects.toThrowError(/TOOL_UNAVAILABLE/);
  });
});
