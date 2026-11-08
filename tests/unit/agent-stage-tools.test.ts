import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  composeVideoStepV2,
  generateCaptions,
  generateCopy,
  generateImages,
  generateScenes,
  generateSpeech,
  generateStoryboard,
  readCopyDocument,
  readSceneSpec,
  readThemeSnapshot,
  readTimelineV2,
  type SystemConfig,
} from "@videoforge/pipeline";
import { renderShots } from "@videoforge/remotion-engine";
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
// render-input（T204）消费的读取器也在此 mock，由用例按需编排返回值
vi.mock("@videoforge/pipeline", () => ({
  generateCopy: vi.fn(),
  generateImages: vi.fn(),
  generateScenes: vi.fn(),
  generateSpeech: vi.fn(),
  generateCaptions: vi.fn(),
  generateStoryboard: vi.fn(),
  composeVideoStepV2: vi.fn(),
  readCopyDocument: vi.fn(),
  readTimelineV2: vi.fn(),
  readThemeSnapshot: vi.fn(),
  readSceneSpec: vi.fn(),
  resolveArtifactPath: vi.fn((root: string, relativePath: string) => join(root, relativePath)),
  CAPTIONS_RELATIVE_PATH: "captions/subtitle.ass",
  SCENE_SPEC_RELATIVE_PATH: "scenes/spec.json",
}));
vi.mock("@videoforge/remotion-engine", () => ({ renderShots: vi.fn() }));

/** 被 mock 的内核函数（类型化引用，便于断言入参）。 */
const kernel = {
  generateCopy: vi.mocked(generateCopy),
  generateImages: vi.mocked(generateImages),
  generateScenes: vi.mocked(generateScenes),
  generateSpeech: vi.mocked(generateSpeech),
  generateCaptions: vi.mocked(generateCaptions),
  generateStoryboard: vi.mocked(generateStoryboard),
  composeVideoStepV2: vi.mocked(composeVideoStepV2),
  renderShots: vi.mocked(renderShots),
  readCopyDocument: vi.mocked(readCopyDocument),
  readTimelineV2: vi.mocked(readTimelineV2),
  readThemeSnapshot: vi.mocked(readThemeSnapshot),
  readSceneSpec: vi.mocked(readSceneSpec),
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
    // 最小配置夹具：本阶段用到 runtime.max_concurrent_stage（渲染 worker）、
    // runtime.scene_concurrency 与 tools.chromium_path（remotion browserExecutable）
    config: {
      runtime: { max_concurrent_stage: 3, scene_concurrency: 5 },
      tools: { chromium_path: "" },
    } as unknown as SystemConfig,
  };
  tools = createStageTools(context) as AnyStageTool[];

  kernel.generateCopy.mockResolvedValue({ out: join(projectDir, "copy.json"), sceneCount: 3 });
  kernel.generateImages.mockResolvedValue({
    images: [join(projectDir, "images", "s1.png")],
    generated: ["s1"],
  });
  kernel.generateScenes.mockResolvedValue({
    scenes: [join(projectDir, "scenes", "s1.html")],
    fallbacks: [],
    generated: ["s1"],
  });
  kernel.generateSpeech.mockResolvedValue({
    audios: [join(projectDir, "audio", "s1.mp3")],
    generated: ["s1"],
  });
  // generateCaptions 是同步内核函数，用 mockReturnValue 保持与真实签名一致
  kernel.generateCaptions.mockReturnValue({
    outPath: join(projectDir, "captions", "subtitle.ass"),
    cueCount: 12,
    shotCount: 6,
    themeId: "documentary-dark",
  });
  kernel.generateStoryboard.mockResolvedValue({
    out: join(projectDir, "timeline.json"),
    totalMs: 5000,
  });
  kernel.composeVideoStepV2.mockResolvedValue(join(projectDir, "final.mp4"));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("阶段工具：参数 → 内核调用映射", () => {
  test("返回 8 个工具且顺序即阶段顺序", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "copy_generate",
      "image_generate",
      "scene_generate",
      "tts_generate",
      "captions_generate",
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

  test("copy_generate：context.contractVersion 透传，v2 摘要按镜头数", async () => {
    context.contractVersion = "2.0";
    tools = createStageTools(context) as AnyStageTool[];
    kernel.generateCopy.mockResolvedValue({
      out: join(projectDir, "copy.json"),
      sceneCount: 6,
      shotCount: 78,
    });

    const result = await invoke("copy_generate", { topic: "黑洞" });

    expect(kernel.generateCopy).toHaveBeenCalledWith(
      expect.objectContaining({ contractVersion: "2.0" }),
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("78 个镜头"),
    });
  });

  test("image_generate：缺省不传范围时字段为 undefined，copyPath 固定为 <projectDir>/copy.json", async () => {
    await invoke("image_generate");

    expect(kernel.generateImages).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      promptSet: undefined,
      runId: "run-1",
      sceneIds: undefined,
      shotIds: undefined,
      promptOverride: undefined,
      mode: undefined,
    });
  });

  test("image_generate：v2 镜头范围透传 shotIds", async () => {
    await invoke("image_generate", { shotIds: ["sh-023"] });

    expect(kernel.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ shotIds: ["sh-023"] }),
    );
  });

  test("image_generate：定向重生成只透传指定场景与画面描述覆盖", async () => {
    await invoke("image_generate", {
      sceneIds: ["s1"],
      promptOverride: "改成夜景霓虹街道",
      mode: "all",
    });

    expect(kernel.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneIds: ["s1"],
        promptOverride: "改成夜景霓虹街道",
        mode: "all",
      }),
    );
  });

  test("scene_generate：profile 取 context.profile，concurrency 取 runtime.scene_concurrency", async () => {
    await invoke("scene_generate");

    expect(kernel.generateScenes).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      promptSet: undefined,
      profile: "LANDSCAPE_1080P",
      onlyFallbacks: false,
      concurrency: 5,
      runId: "run-1",
      sceneIds: undefined,
      promptOverride: undefined,
    });
  });

  test("scene_generate：定向重生成只透传指定场景", async () => {
    await invoke("scene_generate", { sceneIds: ["s2"], promptOverride: "更快的节奏" });

    expect(kernel.generateScenes).toHaveBeenCalledWith(
      expect.objectContaining({ sceneIds: ["s2"], promptOverride: "更快的节奏" }),
    );
  });

  test("tts_generate：不接收 speaker 入参，音色固定取配置默认", async () => {
    await invoke("tts_generate");

    expect(kernel.generateSpeech).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      runId: "run-1",
      sceneIds: undefined,
      shotIds: undefined,
    });
  });

  test("tts_generate：v2 镜头范围透传 shotIds", async () => {
    await invoke("tts_generate", { shotIds: ["sh-023"] });

    expect(kernel.generateSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ shotIds: ["sh-023"] }),
    );
  });

  test("captions_generate：按 projectDir 生成字幕轨并返回 cue 条数", async () => {
    const result = await invoke("captions_generate");

    expect(kernel.generateCaptions).toHaveBeenCalledWith({ projectDir });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("12 条"),
    });
    expect(result.details).toEqual({ artifacts: ["captions/subtitle.ass"] });
  });

  test("storyboard_generate：timeline.json 输出到 projectDir", async () => {
    await invoke("storyboard_generate");

    expect(kernel.generateStoryboard).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      outFile: join(projectDir, "timeline.json"),
      runId: "run-1",
      profile: "LANDSCAPE_1080P",
    });
  });

  test("render_frames：profile 名映射为镜头帧目录，workers 取 max_concurrent_stage", async () => {
    stubV2Project();
    await invoke("render_frames", { profile: "landscape-1080p" });

    expect(kernel.renderShots).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: join(projectDir, "build", "render", "landscape", "shots"),
        concurrency: 3,
      }),
    );
  });

  test("render_frames：portrait-1080p 映射为 portrait 目录", async () => {
    stubV2Project();
    await invoke("render_frames", { profile: "portrait-1080p" });

    expect(kernel.renderShots).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: join(projectDir, "build", "render", "portrait", "shots"),
        concurrency: 3,
      }),
    );
  });

  test("compose_video：成片固定为 <projectDir>/final.mp4", async () => {
    await invoke("compose_video", { profile: "portrait-1080p" });

    expect(kernel.composeVideoStepV2).toHaveBeenCalledWith(
      expect.objectContaining({
        outFile: join(projectDir, "final.mp4"),
        profile: "PORTRAIT_1080P",
      }),
    );
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

  test("场景类工具只暴露定向范围参数，storyboard 仍无参", () => {
    const expected: Record<string, string[]> = {
      image_generate: ["mode", "promptOverride", "promptSet", "sceneIds", "shotIds"],
      scene_generate: ["promptOverride", "promptSet", "sceneIds"],
      tts_generate: ["sceneIds", "shotIds"],
      storyboard_generate: [],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const properties = (toolByName(name).parameters as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(properties).sort()).toEqual(fields);
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
    expect(kernel.renderShots).not.toHaveBeenCalled();
  });

  test("compose_video：非法 profile 返回 CONFIG_INVALID", async () => {
    const result = await invoke("compose_video", { profile: "square-1080p" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
    expect(kernel.composeVideoStepV2).not.toHaveBeenCalled();
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
    stubV2Project();
    kernel.renderShots.mockImplementation(() => new Promise(() => {}));

    const pending = invoke("render_frames", { profile: "landscape-1080p" });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "TOOL_UNAVAILABLE" });
  });

  test("compose_video：内核永不 resolve 时超时收口为 TOOL_UNAVAILABLE", async () => {
    vi.useFakeTimers();
    kernel.composeVideoStepV2.mockImplementation(() => new Promise(() => {}));

    const pending = invoke("compose_video", { profile: "landscape-1080p" });
    await vi.advanceTimersByTimeAsync(COMPOSE_TIMEOUT_MS);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "TOOL_UNAVAILABLE" });
  });
});

/** 构造最小 copy v2 文档（两镜头：sh-001 带图片、sh-002 无）。 */
function makeCopyV2() {
  return {
    contractVersion: "2.0",
    topic: "黑洞",
    style: "科普",
    title: "黑洞简介",
    theme: { id: "documentary-dark" },
    styleAnchors: [],
    scenes: [
      {
        sceneId: "s1",
        title: "开篇",
        shots: [
          {
            shotId: "sh-001",
            narration: "黑洞是时空的极端弯曲。",
            onScreenText: "",
            emphasis: [],
            visualType: "image",
            assetRefs: [],
            anchorKeys: [],
            imagePath: "images/sh-001.png",
          },
          {
            shotId: "sh-002",
            narration: "光也无法逃逸。",
            onScreenText: "",
            emphasis: [],
            visualType: "component",
            assetRefs: [],
            anchorKeys: [],
          },
        ],
      },
    ],
  };
}

/** 构造最小 timeline v2（与 copy 镜头对应，30fps）。 */
function makeTimelineV2() {
  return {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 0,
    timingSource: "estimated",
    totalMs: 2000,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
    ],
    cues: [],
  };
}

/** 构造最小主题快照（readThemeSnapshot 返回形状）。 */
function makeThemeSnapshot() {
  return {
    version: "1",
    themeId: "documentary-dark",
    resolvedAt: "2026-11-07T00:00:00.000Z",
    theme: {
      id: "documentary-dark",
      name: "纪录深色",
      frame: { width: 1920, height: 1080, safe_area: 0.06 },
      tokens: {
        text: "#EAECEF",
        background: "#101216",
        accent: "#E4B95B",
        secondary: [],
        font_family: "Noto Sans SC",
        title_size: 72,
        body_size: 40,
        caption: { size: 36, stroke: 0, bottom_ratio: 0.08, max_chars_per_line: 18 },
      },
      motion: { min_duration_ms: 300, max_duration_ms: 800 },
    },
  };
}

/** 编排 v2 项目产物读取器与 renderShots 返回值（render v2 分支的输入夹具）。 */
function stubV2Project() {
  kernel.readCopyDocument.mockReturnValue({ version: "2", doc: makeCopyV2() } as any);
  kernel.readTimelineV2.mockReturnValue(makeTimelineV2() as any);
  kernel.readThemeSnapshot.mockReturnValue(makeThemeSnapshot() as any);
  kernel.readSceneSpec.mockReturnValue(null);
  kernel.renderShots.mockResolvedValue({
    entries: [
      { shotId: "sh-001", sceneId: "s1", fromFrame: 0, durationInFrames: 30, startMs: 0, durationMs: 1000 },
      { shotId: "sh-002", sceneId: "s1", fromFrame: 30, durationInFrames: 30, startMs: 1000, durationMs: 1000 },
    ],
    totalFrames: 60,
    serveUrl: "serve-url",
  } as any);
  // imagePath 存在性检查落在真实文件系统：补一张图片，让 sh-001 进入 imageByShot
  mkdirSync(join(projectDir, "images"), { recursive: true });
  writeFileSync(join(projectDir, "images", "sh-001.png"), "png", "utf-8");
}

describe("阶段工具：v2 render 切 Remotion 与 SSE 事件（T204）", () => {
  test("render_frames v2：走 renderShots（publicDir/镜头目录/并发透传）并发布 preview.ready", async () => {
    stubV2Project();
    context.contractVersion = "2.0";
    const publishEvent = vi.fn();
    context.publishEvent = publishEvent;

    const result = await invoke("render_frames", { profile: "landscape-1080p" });

    expect(kernel.renderShots).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoint: join(rootDir, "packages", "remotion-engine", "src", "entry.tsx"),
        timeline: makeTimelineV2(),
        specShots: [],
        imageByShot: { "sh-001": "sh-001.png" },
        publicDir: join(projectDir, "images"),
        outputDir: join(projectDir, "build", "render", "landscape", "shots"),
        concurrency: 3,
        browserExecutable: undefined,
      }),
    );
    expect(publishEvent).toHaveBeenCalledWith("preview.ready", {
      shotIds: ["sh-001", "sh-002"],
      totalFrames: 60,
      shotsDir: "build/render/landscape/shots",
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ artifacts: ["build/render/landscape/shots"] });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("60 帧"),
    });
  });

  test("render_frames v2：缺主题快照报 CONFIG_INVALID，且不触发渲染", async () => {
    stubV2Project();
    kernel.readThemeSnapshot.mockReturnValue(null);
    context.contractVersion = "2.0";

    const result = await invoke("render_frames", { profile: "landscape-1080p" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
    expect(kernel.renderShots).not.toHaveBeenCalled();
  });

  test("render_frames v2：preview.ready 发布失败不影响工具结果", async () => {
    stubV2Project();
    context.contractVersion = "2.0";
    context.publishEvent = vi.fn(() => {
      throw new Error("sse down");
    });

    const result = await invoke("render_frames", { profile: "landscape-1080p" });

    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ artifacts: ["build/render/landscape/shots"] });
  });

  test("image_generate v2：发布 asset.bound（生成镜头与计数）", async () => {
    context.contractVersion = "2.0";
    kernel.generateImages.mockResolvedValue({
      images: [join(projectDir, "images", "sh-001.png")],
      generated: ["sh-001"],
    });
    const publishEvent = vi.fn();
    context.publishEvent = publishEvent;

    await invoke("image_generate", { shotIds: ["sh-001"] });

    expect(publishEvent).toHaveBeenCalledWith("asset.bound", {
      shotIds: ["sh-001"],
      count: 1,
    });
  });

  test("image_generate v1：不发布 asset.bound", async () => {
    const publishEvent = vi.fn();
    context.publishEvent = publishEvent;

    await invoke("image_generate");

    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe("阶段工具：compose v2 与字幕/BGM/响度参数（T205）", () => {
  /** 在项目上传目录写入一个 BGM 资产（assets/uploads/<id>/<file>）。 */
  function writeBgmAsset(assetId: string): void {
    const dir = join(projectDir, "assets", "uploads", assetId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "theme-song.mp3"), "mp3", "utf-8");
  }

  test("compose_video v2：走 composeVideoStepV2，字幕/BGM/响度透传", async () => {
    context.contractVersion = "2.0";
    writeBgmAsset("asset-bgm-1");

    await invoke("compose_video", {
      profile: "landscape-1080p",
      captions: false,
      bgm: "asset-bgm-1",
      bgmVolume: 0.3,
      loudnessTarget: -14,
    });

    expect(kernel.composeVideoStepV2).toHaveBeenCalledWith({
      rootDir,
      copyPath: join(projectDir, "copy.json"),
      outFile: join(projectDir, "final.mp4"),
      profile: "LANDSCAPE_1080P",
      bgmPath: join(projectDir, "assets", "uploads", "asset-bgm-1", "theme-song.mp3"),
      bgmVolume: 0.3,
      loudnessTarget: -14,
      burnCaptions: false,
      runId: "run-1",
    });
  });

  test("compose_video v2：缺省时字幕默认烧录、响度目标默认 -16、无 BGM", async () => {
    context.contractVersion = "2.0";

    await invoke("compose_video", { profile: "landscape-1080p" });

    expect(kernel.composeVideoStepV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loudnessTarget: -16,
        burnCaptions: undefined,
        bgmPath: undefined,
      }),
    );
  });

  test("compose_video：bgm 传路径而非资产 ID 时拒绝", async () => {
    const result = await invoke("compose_video", {
      profile: "landscape-1080p",
      bgm: "assets/uploads/evil.mp3",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
    expect(kernel.composeVideoStepV2).not.toHaveBeenCalled();
  });

  test("compose_video：bgm 资产不存在时拒绝", async () => {
    const result = await invoke("compose_video", {
      profile: "landscape-1080p",
      bgm: "no-such-asset",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorCode: "CONFIG_INVALID" });
  });
});
