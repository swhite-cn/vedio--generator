import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import { Type, type Static, type TSchema } from "typebox";

/**
 * 七个「阶段工具」的 TypeBox 定义（见设计文档 §5.4）。
 *
 * 设计铁律：
 * - **入参不含任何路径**：项目目录、copyPath、outFile 全部由运行时注入的 `StageToolContext` 决定，
 *   模型无法指定写盘位置（避免退化为任意路径写入）；
 * - handler 整体 try/catch，异常**绝不冒泡**：`VideoForgeError` 原样透传 `errorCode`，
 *   其它异常收口为 `TOOL_UNAVAILABLE`；错误码承载在 `content`（模型可见）与
 *   `structuredContent` / `details`（程序可见，见 SPIKE §6，SDK 无 `errorCode` 字段）；
 * - 渲染 / 合成阶段带代码常量超时（不进配置），超时按 `TOOL_UNAVAILABLE` 收尾。
 */

/** 渲染阶段超时（30 分钟）：逐帧截图耗时长，超时视为工具不可用。 */
export const RENDER_TIMEOUT_MS = 30 * 60 * 1000;

/** 合成阶段超时（20 分钟）：ffmpeg 合成超时视为工具不可用。 */
export const COMPOSE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Profile 目录名（`config/profiles/<名>.yaml`）→ `OutputProfile` 枚举值映射表。
 * **新增输出 Profile 时必须同步本表，并在 `config/profiles/` 放入同名 YAML**；
 * 工具入参只接受「目录名」，内核只接受枚举值，二者的转换只依赖这张表。
 */
export const PROFILE_NAME_TO_OUTPUT_PROFILE: Readonly<Record<string, OutputProfile>> = {
  "landscape-1080p": "LANDSCAPE_1080P",
  "portrait-1080p": "PORTRAIT_1080P",
};

/** 阶段工具运行上下文：由运行时（会话注册表 / 工作流引擎）注入，模型无法覆盖。 */
export interface StageToolContext {
  /** 仓库根目录（内核用它加载 `config/*` 与 `.env.local`）。 */
  rootDir: string;
  /** 项目工作目录（所有产物的写盘根，工具参数里绝不出现路径）。 */
  projectDir: string;
  /** 项目输出画幅（由 `projects.profile` 注入）。 */
  profile: OutputProfile;
  /** 项目风格（由 `projects.style` 注入，`copy_generate` 未显式传 style 时回退使用）。 */
  style?: string;
  /** 运行 ID（写运行轨迹用）。 */
  runId?: string;
  /** 系统配置（本文件只用到 `runtime.max_concurrent_stage`）。 */
  config: SystemConfig;
}

/**
 * 阶段工具的结果 details。
 * 成功时只有 `artifacts`（产物相对项目目录的路径），失败时只有 `errorCode`（稳定错误码）。
 */
export interface StageToolDetails {
  /** 成功：产物相对项目目录的路径列表。 */
  artifacts?: string[];
  /** 失败：稳定错误码（SDK 无 `errorCode` 字段，承载于 `details` / `structuredContent`）。 */
  errorCode?: string;
}

/** 阶段工具执行体的产出：人类可读摘要 + 产物相对项目目录的路径列表。 */
interface StageToolOutcome {
  summary: string;
  artifacts: string[];
}

/** 单个阶段工具的内部规格：参数 schema + 执行体（执行体只返回摘要与产物，不处理异常）。 */
interface StageToolSpec<TParams extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  /** 超时毫秒数；仅长阶段（渲染 / 合成）设置。 */
  timeoutMs?: number;
  /** 超时错误信息里的阶段名。 */
  timeoutLabel?: string;
  /** 执行体：入参为已校验的工具参数，返回人类可读摘要与产物相对路径。 */
  run: (params: Static<TParams>, context: StageToolContext) => Promise<StageToolOutcome>;
}

/**
 * 规格的类型擦除视图：用于把参数类型各异的规格收进同一个数组。
 * `run` 的入参放宽为 `any`（与 `StageToolSpec<具体 schema>` 双向兼容），
 * 每个规格自身仍以 `StageToolSpec<typeof 参数 schema>` 精确标注。
 */
interface AnyStageToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  timeoutMs?: number;
  timeoutLabel?: string;
  run: (params: any, context: StageToolContext) => Promise<StageToolOutcome>;
}

/** 阶段顺序的 7 个工具名（供测试与运行时核对）。 */
const STAGE_TOOL_NAMES = [
  "copy_generate",
  "image_generate",
  "scene_generate",
  "tts_generate",
  "storyboard_generate",
  "render_frames",
  "compose_video",
] as const;

/** 把绝对路径转成相对项目目录的展示路径（统一正斜杠，便于跨平台断言与展示）。 */
function toProjectRelative(projectDir: string, target: string): string {
  return relative(projectDir, target).split(sep).join("/");
}

/** 过滤并转换内核返回的产物路径列表（内核允许返回 `undefined` 表示该场景无产物）。 */
function toArtifacts(projectDir: string, paths: Array<string | undefined>): string[] {
  return paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => toProjectRelative(projectDir, path));
}

/** 列出 `config/profiles/` 下已登记的 Profile 名（去掉 `.yaml` 后缀）。 */
function listProfileNames(rootDir: string): Set<string> {
  const dir = join(rootDir, "config", "profiles");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `无法读取输出 Profile 目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return new Set(
    entries
      .filter((entry) => entry.endsWith(".yaml"))
      .map((entry) => entry.slice(0, -".yaml".length)),
  );
}

/**
 * 校验工具入参里的 Profile 名并映射为内核使用的 `OutputProfile` 枚举值。
 * 只接受 `config/profiles/` 下真实存在的目录名，其它一律 `CONFIG_INVALID`。
 * @param rootDir 仓库根目录
 * @param name 工具入参中的 Profile 名（如 `landscape-1080p`）
 * @returns 对应的 `OutputProfile` 枚举值
 * @throws VideoForgeError(`CONFIG_INVALID`) Profile 不存在或未登记映射
 */
export function resolveOutputProfile(rootDir: string, name: string): OutputProfile {
  if (!listProfileNames(rootDir).has(name)) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `未知的输出 Profile "${name}"，可选值见 config/profiles/ 下的 yaml 文件名`,
    );
  }
  const profile = PROFILE_NAME_TO_OUTPUT_PROFILE[name];
  if (!profile) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `Profile "${name}" 未登记到 PROFILE_NAME_TO_OUTPUT_PROFILE（新增 Profile 时需同步该映射表）`,
    );
  }
  return profile;
}

/**
 * 把任意异常收敛为携带稳定错误码的失败结果。
 * `VideoForgeError` 的 `code` 原样透传，其它异常统一 `TOOL_UNAVAILABLE`。
 * @param error 捕获到的异常
 * @returns 失败态 `AgentToolResult`
 */
function toErrorResult(error: unknown): AgentToolResult<StageToolDetails> {
  const errorCode = error instanceof VideoForgeError ? error.code : "TOOL_UNAVAILABLE";
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${errorCode}: ${message}` }],
    structuredContent: { errorCode },
    details: { errorCode },
  };
}

/**
 * 为长阶段执行体加上代码常量超时。
 * 超时后 `abort()` 内部 `AbortController`（内核当前不接收 signal，属尽力而为）并以
 * `TOOL_UNAVAILABLE` 拒绝；成功返回时清理定时器，避免悬挂的拒绝。
 * @param run 执行体
 * @param timeoutMs 超时毫秒数
 * @param label 超时信息中的阶段名
 * @returns 执行体结果
 * @throws VideoForgeError(`TOOL_UNAVAILABLE`) 超时
 */
async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VideoForgeError("TOOL_UNAVAILABLE", `${label} 执行超时（超过 ${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 把阶段工具规格包装成 SDK 的 `ToolDefinition`：统一做计时日志、超时与异常收口。
 * @param spec 阶段工具规格（类型擦除视图）
 * @param context 运行时注入的上下文
 * @returns 可直接交给 `createAgentSession({ customTools })` 的工具定义
 */
function createStageTool(
  spec: AnyStageToolSpec,
  context: StageToolContext,
): ToolDefinition<any, StageToolDetails> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_toolCallId, params): Promise<AgentToolResult<StageToolDetails>> {
      const startedAt = Date.now();
      try {
        const operation = () => spec.run(params, context);
        const outcome = spec.timeoutMs
          ? await withTimeout(operation, spec.timeoutMs, spec.timeoutLabel ?? spec.name)
          : await operation();
        console.info(
          `[stage-tools] ${spec.name} 完成：${outcome.artifacts.join(", ") || "（无产物）"}（${Date.now() - startedAt}ms）`,
        );
        return {
          content: [{ type: "text", text: outcome.summary }],
          details: { artifacts: outcome.artifacts },
        };
      } catch (error) {
        const failure = toErrorResult(error);
        const errorCode = failure.details.errorCode;
        console.error(
          `[stage-tools] ${spec.name} 失败：${errorCode}（${Date.now() - startedAt}ms）`,
        );
        return failure;
      }
    },
  };
}

/**
 * 构造 7 个阶段工具（顺序即阶段顺序），入参 schema 为 TypeBox。
 * @param context 运行时注入的项目上下文（根目录、项目目录、画幅、风格、runId、配置）
 * @returns 按阶段顺序排列的阶段工具定义数组
 */
export function createStageTools(
  context: StageToolContext,
): ToolDefinition<any, StageToolDetails>[] {
  const copyPath = join(context.projectDir, "copy.json");
  const timelinePath = join(context.projectDir, "timeline.json");
  const finalPath = join(context.projectDir, "final.mp4");
  const concurrency = context.config.runtime.max_concurrent_stage;

  // 工具参数 schema：绝不包含路径字段，产物位置一律由 context 决定
  const copyParameters = Type.Object({
    topic: Type.String({ minLength: 1, description: "视频主题" }),
    style: Type.Optional(Type.String({ description: "文案与画面的风格提示；缺省沿用项目风格" })),
    promptSet: Type.Optional(
      Type.String({ description: "提示词集名（config/prompts/<集名>/）；缺省用配置默认集" }),
    ),
  });
  const emptyParameters = Type.Object({});
  const ttsParameters = Type.Object({
    speaker: Type.Optional(Type.String({ description: "TTS 说话人；缺省用配置默认说话人" })),
  });
  const profileParameters = Type.Object({
    profile: Type.String({
      minLength: 1,
      description: "输出 Profile 名（config/profiles/ 下的文件目录名）",
    }),
  });

  const copySpec: StageToolSpec<typeof copyParameters> = {
    name: "copy_generate",
    label: "文案生成",
    description:
      "按主题生成分镜文案并写入项目内的 copy.json。这是七阶段流水线的第一步；入参只接受主题、风格与提示词集名，不接受任何路径。",
    parameters: copyParameters,
    async run(params, ctx) {
      const result = await generateCopy({
        rootDir: ctx.rootDir,
        topic: params.topic,
        style: params.style ?? ctx.style ?? "",
        promptSet: params.promptSet,
        outFile: copyPath,
        runId: ctx.runId,
      });
      return {
        summary: `已生成文案 copy.json，共 ${result.sceneCount} 个场景。`,
        artifacts: ["copy.json"],
      };
    },
  };

  const imageSpec: StageToolSpec<typeof emptyParameters> = {
    name: "image_generate",
    label: "配图生成",
    description:
      "按 copy.json 的口播与画面描述逐场景生成配图，写入项目内的 images/ 并回填 copy.json。需先完成 copy_generate。",
    parameters: emptyParameters,
    async run(_params, ctx) {
      const result = await generateImages({ rootDir: ctx.rootDir, copyPath, runId: ctx.runId });
      const artifacts = toArtifacts(ctx.projectDir, result.images);
      return { summary: `已生成 ${artifacts.length} 张配图（images/）。`, artifacts };
    },
  };

  const sceneSpec: StageToolSpec<typeof emptyParameters> = {
    name: "scene_generate",
    label: "场景生成",
    description:
      "为每个场景生成 HTML+GSAP 动画页面，写入项目内的 scenes/ 并回填 copy.json。需先完成 copy_generate（有配图效果更好）。",
    parameters: emptyParameters,
    async run(_params, ctx) {
      const result = await generateScenes({
        rootDir: ctx.rootDir,
        copyPath,
        profile: ctx.profile,
        onlyFallbacks: false,
        concurrency,
        runId: ctx.runId,
      });
      const artifacts = toArtifacts(ctx.projectDir, result.scenes);
      const fallbackNote =
        result.fallbacks.length > 0 ? `，其中 ${result.fallbacks.length} 个场景使用了降级模板` : "";
      return {
        summary: `已生成 ${artifacts.length} 个场景页面（scenes/）${fallbackNote}。`,
        artifacts,
      };
    },
  };

  const ttsSpec: StageToolSpec<typeof ttsParameters> = {
    name: "tts_generate",
    label: "语音合成",
    description:
      "按 copy.json 的逐场景口播合成语音，写入项目内的 audio/ 并回填 copy.json。需先完成 copy_generate。",
    parameters: ttsParameters,
    async run(params, ctx) {
      const result = await generateSpeech({
        rootDir: ctx.rootDir,
        copyPath,
        speaker: params.speaker,
        runId: ctx.runId,
      });
      const artifacts = toArtifacts(ctx.projectDir, result.audios);
      return { summary: `已合成 ${artifacts.length} 段语音（audio/）。`, artifacts };
    },
  };

  const storyboardSpec: StageToolSpec<typeof emptyParameters> = {
    name: "storyboard_generate",
    label: "时间轴生成",
    description: "用 ffprobe 实测各场景语音时长，生成项目内 timeline.json。需先完成 tts_generate。",
    parameters: emptyParameters,
    async run(_params, ctx) {
      const result = await generateStoryboard({
        rootDir: ctx.rootDir,
        copyPath,
        outFile: timelinePath,
        runId: ctx.runId,
      });
      return {
        summary: `已生成时间轴 timeline.json，总时长 ${result.totalMs}ms。`,
        artifacts: ["timeline.json"],
      };
    },
  };

  const renderSpec: StageToolSpec<typeof profileParameters> = {
    name: "render_frames",
    label: "逐帧渲染",
    description:
      "按 timeline.json 逐帧渲染 JPEG 帧序列到项目内的 build/render/<profile>/frames/。需先完成 storyboard_generate。",
    parameters: profileParameters,
    timeoutMs: RENDER_TIMEOUT_MS,
    timeoutLabel: "render_frames",
    async run(params, ctx) {
      const profile = resolveOutputProfile(ctx.rootDir, params.profile);
      const result = await renderFrames({
        rootDir: ctx.rootDir,
        copyPath,
        timelinePath,
        profile,
        workers: concurrency,
        runId: ctx.runId,
      });
      const artifact = toProjectRelative(ctx.projectDir, result.framesDir);
      return { summary: `已渲染 ${result.frameCount} 帧（${artifact}/）。`, artifacts: [artifact] };
    },
  };

  const composeSpec: StageToolSpec<typeof profileParameters> = {
    name: "compose_video",
    label: "视频合成",
    description: "把帧序列与语音合成为项目内的 final.mp4（成片唯一名称）。需先完成 render_frames。",
    parameters: profileParameters,
    timeoutMs: COMPOSE_TIMEOUT_MS,
    timeoutLabel: "compose_video",
    async run(params, ctx) {
      const profile = resolveOutputProfile(ctx.rootDir, params.profile);
      await composeVideoStep({
        rootDir: ctx.rootDir,
        copyPath,
        outFile: finalPath,
        profile,
        runId: ctx.runId,
      });
      return { summary: "已合成成片 final.mp4。", artifacts: ["final.mp4"] };
    },
  };

  const specs: AnyStageToolSpec[] = [
    copySpec,
    imageSpec,
    sceneSpec,
    ttsSpec,
    storyboardSpec,
    renderSpec,
    composeSpec,
  ];

  // 规格数组与阶段名顺序一一对应，构造期即自检，避免后续改动静默错位
  if (specs.map((spec) => spec.name).join(",") !== STAGE_TOOL_NAMES.join(",")) {
    throw new VideoForgeError("CONFIG_INVALID", "阶段工具顺序与阶段顺序不一致");
  }
  return specs.map((spec) => createStageTool(spec, context));
}
