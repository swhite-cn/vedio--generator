import { z } from "zod";
import {
  PIPELINE_STAGES,
  REVIEW_GATE_STAGES,
  type CapabilityDeclaration,
  type CapabilityStageDeclaration,
  type CapabilityView,
  type PipelineStage,
} from "@videoforge/shared";

/**
 * `video-generation` 阶段声明：阶段名、阶段工具名与阶段展示名。
 * 顺序即阶段执行顺序（见设计文档 §6.1）。
 */
const STAGE_TOOL_AND_LABEL: Record<PipelineStage, { tool: string; label: string }> = {
  copy: { tool: "copy_generate", label: "文案生成" },
  image: { tool: "image_generate", label: "配图生成" },
  scene: { tool: "scene_generate", label: "场景生成" },
  tts: { tool: "tts_generate", label: "语音合成" },
  storyboard: { tool: "storyboard_generate", label: "时间轴生成" },
  render: { tool: "render_frames", label: "逐帧渲染" },
  compose: { tool: "compose_video", label: "视频合成" },
};

/** 审核点阶段集合（元素级查找用），见设计文档 §6.4。 */
const REVIEW_GATE_SET: ReadonlySet<string> = new Set(REVIEW_GATE_STAGES);

/**
 * 构造 `video-generation` 的七阶段声明，每阶段带上产物判据（见设计文档 §3.6、§6.1）。
 * @returns 按阶段顺序排列的阶段声明数组
 */
function buildVideoGenerationStages(): CapabilityStageDeclaration[] {
  return PIPELINE_STAGES.map((stage) => {
    const { tool, label } = STAGE_TOOL_AND_LABEL[stage];
    const base = { stage, tool, label, reviewGate: REVIEW_GATE_SET.has(stage) };
    switch (stage) {
      case "copy":
        return {
          ...base,
          artifact: { kind: "file", relativePath: "copy.json", validator: "copy-contract" },
        };
      case "image":
        return { ...base, artifact: { kind: "glob", pattern: "images/*.png", minCount: 1 } };
      case "scene":
        return { ...base, artifact: { kind: "glob", pattern: "scenes/*.html", minCount: 1 } };
      case "tts":
        return { ...base, artifact: { kind: "glob", pattern: "audio/*.mp3", minCount: 1 } };
      case "storyboard":
        return {
          ...base,
          artifact: { kind: "file", relativePath: "timeline.json", validator: "timeline-contract" },
        };
      case "render":
        return {
          ...base,
          artifact: {
            kind: "glob",
            pattern: "build/render/<profile>/frames/*.jpg",
            minCount: 1,
          },
        };
      case "compose":
        return { ...base, artifact: { kind: "file", relativePath: "final.mp4" } };
    }
  });
}

/**
 * 内置能力注册表，见设计文档 §3.6。
 * 当前仅 `video-generation`（短视频生成）。
 */
export const BUILT_IN_CAPABILITIES: CapabilityDeclaration[] = [
  {
    id: "video-generation",
    name: "短视频生成",
    description: "从主题到成片的七阶段线性流水线：文案、配图、场景、语音、时间轴、渲染、合成。",
    stages: buildVideoGenerationStages(),
    reviewGates: [...REVIEW_GATE_STAGES],
    params: [
      {
        name: "topic",
        required: true,
        description: "视频主题，作为文案与画面的输入。",
      },
      {
        name: "style",
        required: false,
        description: "文案与画面的风格提示。",
      },
      {
        name: "profile",
        required: false,
        description: "输出画幅 Profile。",
        enumValues: ["landscape-1080p", "portrait-1080p"],
        defaultValue: "landscape-1080p",
      },
    ],
    // 创建项目时的参数契约校验器（非 JSON 序列化，只读视图会剥离）。
    paramsSchema: z.object({
      topic: z.string().min(1),
      style: z.string().optional(),
      profile: z.enum(["landscape-1080p", "portrait-1080p"]).default("landscape-1080p"),
    }),
    skillDirs: [".trae/skills"],
    finalArtifact: "final.mp4",
  },
];

/**
 * 按 id 查找内置能力声明。
 * @param id 能力标识
 * @returns 命中则返回声明，否则返回 `undefined`
 */
export function getCapability(id: string): CapabilityDeclaration | undefined {
  return BUILT_IN_CAPABILITIES.find((capability) => capability.id === id);
}

/**
 * 把能力声明转成可 JSON 返回的只读视图（剥离 `paramsSchema` 等非序列化字段）。
 * @param declaration 能力声明
 * @returns 只读视图
 */
function toCapabilityView(declaration: CapabilityDeclaration): CapabilityView {
  return {
    id: declaration.id,
    name: declaration.name,
    description: declaration.description,
    stages: declaration.stages,
    reviewGates: declaration.reviewGates,
    params: declaration.params,
    skillDirs: declaration.skillDirs,
    finalArtifact: declaration.finalArtifact,
  };
}

/**
 * 列出全部内置能力的只读视图，供 `GET /api/capabilities` 使用。
 * @returns 能力只读视图数组
 */
export function listCapabilities(): CapabilityView[] {
  return BUILT_IN_CAPABILITIES.map(toCapabilityView);
}
