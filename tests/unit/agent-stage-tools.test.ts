import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  composeVideoStep,
  generateCopy,
  generateImages,
  generateScenes,
  generateSpeech,
  generateStoryboard,
  type SystemConfig,
} from "@videoforge/pipeline";
import { renderFrames } from "@videoforge/renderer";
import { VideoForgeError } from "@videoforge/shared";
import {
  COMPOSE_TIMEOUT_MS,
  createStageTools,
  PROFILE_NAME_TO_OUTPUT_PROFILE,
  RENDER_TIMEOUT_MS,
  type StageToolContext,
  type StageToolDetails,
} from "../../apps/server/src/agent/tools/stage-tools";

// 内核全部 mock：本测试只验证「工具参数 → 内核调用」的映射与错误/超时收口
vi.mock("@videoforge/pipeline", () => ({
  generateCopy: vi.fn(),
  generateImages: vi.fn(),
  generateScenes: vi.fn(),
  generateSpeech: vi.fn(),
  generateStoryboard: vi.fn(),
  composeVideoStep: vi.fn(),
}));
vi.mock("@videoforge/renderer", () => ({ renderFrames: vi.fn() }));

/** 被 mock 的内核函数（类型化引用，便于断言入参）。 */
const kernel = {
  generateCopy: vi.mocked(generateCopy),
  generateImages: vi.mocked(generateImages),
  generateScenes: vi.mocked(generateScenes),
  generateSpeech: vi.mocked(generateSpeech),
  generateStoryboard: vi.mocked(generateStoryboard),
  composeVideoStep: vi.mocked(composeVideoStep),
  renderFrames: vi.mocked(renderFrames),
};

/** 任一阶段工具的类型别名。 */
type AnyStageTool = ToolDefinition<any, StageToolDetails>;

/** 单元测试里允许出现的工具参数名白名单（绝不接受路径类字段）。 */
const PATH_LIKE_PARAM_NAMES = [
  "path",
  "dir",
  "cwd",
  "outFile",
  "copyPath",
  "projectDir",
  "rootDir",
];

let rootDir: string;
let projectDir: string;
let context: StageToolContext;
let tools: AnyStageTool[];

/** 按名字取出阶段工具（缺失即测试夹具错误）。 */
function toolByName(name: string): AnyStageTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未找到阶段工具：${name}`);
  return tool;
}

/** 直接调用工具的 execute（本阶段不关心 toolCallId / signal / onUpdate / ctx）。 */
function invoke(name: string, params: Record<string, unknown> = {}) {
  return toolByName(name).execute("test-call", params, undefined, undefined, undefined as any);
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "videoforge-stage-root-"));
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-stage-project-"));
  // Profile 合法性来自 config/profiles/ 下的真实文件扫描，此处写两个空 yaml 夹具
  const profilesDir = join(rootDir, "config", "profiles");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(join(profilesDir, "landscape-1080p.yaml"), "", "utf-8");
  writeFileSync(join(profilesDir, "portrait-1080p.yaml"), "", "utf-8");

  context = {
    rootDir,
    projectDir,
    profile: "LANDSCAPE_1080P",
    style: "科普",
    runId: "run-1",
    // 最小配置夹具：本阶段只用到 runtime.max_concurrent_stage
    config: { runtime: { max_concurrent_stage: 3 } } as unknown as SystemConfig,
  };
  tools = createStageTools(context) as AnyStageTool[];

  kernel.generateCopy.mockResolvedValue({ out: join(projectDir, "copy.json"), sceneCount: 3 });
  kernel.generateImages.mockResolvedValue({ images: [join(projectDir, "images", "s1.png")] });
  kernel.generateScenes.mockResolvedValue({
    scenes: [join(projectDir, "scenes", "s1.html")],
    fallbacks: [],
  });
  kernel.generateSpeech.mockResolvedValue({ audios: [join(projectDir, "audio", "s1.mp3")] });
  kernel.generateStoryboard.mockResolvedValue({
    out: join(projectDir, "timeline.json"),
    totalMs: 5000,
  });
  kernel.renderFrames.mockResolvedValue({
    framesDir: join(projectDir, "build", "render", "landscape", "frames"),
    frameCount: 150,
  });
  kernel.composeVideoStep.mockResolvedValue(join(projectDir, "final.mp4"));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("阶段工具：参数 → 内核调用映射", () => {
  test("返回 7 个工具且顺序即阶段顺序", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "copy_generate",
      "image_generate",
      "scene_generate",
      "tts_generate",
      "storyboard_generate",
      "render_frames",
      "compose_video",
    ]);
  });

  test("copy_generate：topic/style/promptSet 透传，产物固定为 <projectDir>/copy.json", async () => {
    const result = await invoke("copy_generate", {
      topic: "黑洞",
      style: "幽默",
      promptSet: "set-a",
    });

    expect(kernel.generateCopy).toHaveBeenCalledWith({
      rootDir,
      topic: "黑洞",
      style: "幽默",
      promptSet: "set-a",
      outFile: join(projectDir, "copy.json"),
      runId: "run-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ artifacts: ["copy.json"] });
  });

  test("copy_generate：未显式传 style 时回退 context.style", async () => {
    await invoke("copy_generate", { topic: "黑洞" });

    expect(kernel.generateCopy).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "黑洞", style: "科普", promptSet: undefined }),
    );
  });

  test("image_generate：无参调用，copyPath 固定为 <projectDir>/copy.json", async () => {
    await invoke("image_generate");

    expect(kernel.generateImages).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      runId: "run-1",
    });
  });

  test("scene_generate：profile 取 context.profile，concurrency 取 runtime.max_concurrent_stage", async () => {
    await invoke("scene_generate");

    expect(kernel.generateScenes).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      profile: "LANDSCAPE_1080P",
      onlyFallbacks: false,
      concurrency: 3,
      runId: "run-1",
    });
  });

  test("tts_generate：speaker 透传", async () => {
    await invoke("tts_generate", { speaker: "zh-CN-YunxiNeural" });

    expect(kernel.generateSpeech).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      speaker: "zh-CN-YunxiNeural",
      runId: "run-1",
    });
  });

  test("storyboard_generate：timeline.json 输出到 projectDir", async () => {
    await invoke("storyboard_generate");

    expect(kernel.generateStoryboard).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      outFile: join(projectDir, "timeline.json"),
      runId: "run-1",
    });
  });

  test("render_frames：profile 名映射为 OutputProfile，workers 取 max_concurrent_stage", async () => {
    await invoke("render_frames", { profile: "landscape-1080p" });

    expect(kernel.renderFrames).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      timelinePath: join(projectDir, "timeline.json"),
      profile: "LANDSCAPE_1080P",
      workers: 3,
      runId: "run-1",
    });
  });

  test("render_frames：portrait-1080p 映射为 PORTRAIT_1080P", async () => {
    await invoke("render_frames", { profile: "portrait-1080p" });

    expect(kernel.renderFrames).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "PORTRAIT_1080P", workers: 3 }),
    );
  });

  test("compose_video：成片固定为 <projectDir>/final.mp4", async () => {
    await invoke("compose_video", { profile: "portrait-1080p" });

    expect(kernel.composeVideoStep).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      outFile: join(projectDir, "final.mp4"),
      profile: "PORTRAIT_1080P",
      runId: "run-1",
    });
  });

  test("映射表与 config/profiles 当前两个 Profile 一致", () => {
    expect(PROFILE_NAME_TO_OUTPUT_PROFILE).toEqual({
      "landscape-1080p": "LANDSCAPE_1080P",
      "portrait-1080p": "PORTRAIT_1080P",
    });
  });
});

describe("阶段工具：参数 schema 不含路径", () => {
  test("7 个工具的参数字段里没有路径类字段", () => {
    for (const tool of tools) {
      const properties =
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      for (const name of Object.keys(properties)) {
        expect(PATH_LIKE_PARAM_NAMES).not.toContain(name);
      }
    }
  });

  test("copy_generate 只允许 topic / style / promptSet", () => {
    const properties = (
      toolByName("copy_generate").parameters as { properties: Record<string, unknown> }
    ).properties;
    expect(Object.keys(properties).sort()).toEqual(["promptSet", "style", "topic"]);
  });

  test("无参工具（image/scene/storyboard）的参数字段为空", () => {
    for (const name of ["image_generate", "scene_generate", "storyboard_generate"]) {
      const properties = (toolByName(name).parameters as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(properties)).toEqual([]);
    }
  });

  test("仅 render_frames / compose_video 暴露 profile 参数", () => {
    const withProfile = tools
      .filter(
        (tool) =>
          "profile" in
          ((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
      )
      .map((tool) => tool.name);
    expect(withProfile).toEqual(["render_frames", "compose_video"]);
  });
});

describe("阶段工具：错误收口", () => {
  test("render_frames：非法 profile（config/profiles 下不存在）返回 CONFIG_INVALID", async () => {
    const result = await invoke("render_frames", { profile: "square-1080p" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
    expect(kernel.renderFrames).not.toHaveBeenCalled();
  });

  test("compose_video：非法 profile 返回 CONFIG_INVALID", async () => {
    const result = await invoke("compose_video", { profile: "square-1080p" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
    expect(kernel.composeVideoStep).not.toHaveBeenCalled();
  });

  test("VideoForgeError 的错误码原样透传（ADAPTER_FAILED → ADAPTER_FAILED）", async () => {
    kernel.generateCopy.mockRejectedValue(new VideoForgeError("ADAPTER_FAILED", "文案模型不可用"));

    const result = await invoke("copy_generate", { topic: "黑洞" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "ADAPTER_FAILED" });
    expect(result.details).toEqual({ errorCode: "ADAPTER_FAILED" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("ADAPTER_FAILED"),
    });
  });

  test("普通异常不冒泡：Promise resolve 且 errorCode 为 TOOL_UNAVAILABLE", async () => {
    kernel.generateImages.mockRejectedValue(new Error("boom"));

    const result = await invoke("image_generate");

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "TOOL_UNAVAILABLE" });
  });
});

describe("阶段工具：长阶段超时", () => {
  test("render_frames：内核永不 resolve 时超时收口为 TOOL_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    kernel.renderFrames.mockImplementation(() => new Promise(() => {}));

    const pending = invoke("render_frames", { profile: "landscape-1080p" });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "TOOL_UNAVAILABLE" });
  });

  test("compose_video：内核永不 resolve 时超时收口为 TOOL_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    kernel.composeVideoStep.mockImplementation(() => new Promise(() => {}));

    const pending = invoke("compose_video", { profile: "landscape-1080p" });
    await vi.advanceTimersByTimeAsync(COMPOSE_TIMEOUT_MS);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "TOOL_UNAVAILABLE" });
  });
});
