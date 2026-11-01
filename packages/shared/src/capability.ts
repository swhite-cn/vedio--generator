import type { PipelineStage } from "./domain.js";

/**
 * 阶段产物判据（可 JSON 序列化的纯数据，不携带函数）。
 * 由工作流引擎解释（解释器在 Phase 8 实现）：引擎按判据在工作区目录内检查产物。
 * - `file`：检查工作区内的相对路径文件存在；（可选）再用内置契约校验器验证内容。
 * - `glob`：按相对 glob 匹配，命中数需达到 `minCount`。
 * 见设计文档 §3.6、§6.1。
 */
export type ArtifactPredicate =
  | {
      kind: "file";
      /** 相对项目工作区根目录的路径，如 `copy.json`。 */
      relativePath: string;
      /** 可选内置契约校验器标识。 */
      validator?: "copy-contract" | "timeline-contract";
    }
  | {
      kind: "glob";
      /** 相对项目工作区根目录的 glob 模式，如 `images/*.png`。 */
      pattern: string;
      /** 命中文件数下限。 */
      minCount: number;
    };

/**
 * 单个阶段的能力声明，见设计文档 §3.6。
 * 纯数据，可由 `GET /api/capabilities` 原样返回。
 */
export interface CapabilityStageDeclaration {
  /** 阶段标识。 */
  stage: PipelineStage;
  /** 该阶段对应的阶段工具名，如 `copy_generate`。 */
  tool: string;
  /** 该阶段完成后是否触发审核点。 */
  reviewGate: boolean;
  /** 阶段完成判据（产物存在且通过校验）。 */
  artifact: ArtifactPredicate;
  /** 面向用户展示的阶段名。 */
  label: string;
}

/**
 * 创建项目时的单个参数声明（纯数据描述），见设计文档 §3.6。
 * 与 `paramsSchema` 保持一致；`paramsSchema` 承载真实校验逻辑，本类型用于只读视图。
 */
export interface CapabilityParamDeclaration {
  /** 参数名，如 `topic`。 */
  name: string;
  /** 是否必填。 */
  required: boolean;
  /** 面向用户的参数说明。 */
  description: string;
  /** 枚举取值（可选），如 `["landscape-1080p","portrait-1080p"]`。 */
  enumValues?: string[];
  /** 默认值（可选），如 `landscape-1080p`。 */
  defaultValue?: string;
}

/**
 * 能力声明（代码常量，数据驱动），见设计文档 §3.6。
 * 阶段 DAG、审核点、参数契约、技能目录、最终产物均由此描述；
 * 工作流引擎按声明驱动 DAG，引擎本身不含阶段知识。
 */
export interface CapabilityDeclaration {
  /** 能力唯一标识，如 `video-generation`。 */
  id: string;
  /** 能力名称，如 `短视频生成`。 */
  name: string;
  /** 能力说明。 */
  description: string;
  /** 阶段 DAG（本期内置能力为线性链）。 */
  stages: CapabilityStageDeclaration[];
  /** 审核点阶段集合，如 `["copy","image"]`。 */
  reviewGates: PipelineStage[];
  /** 创建项目时的参数契约（纯数据描述，可序列化）。 */
  params: CapabilityParamDeclaration[];
  /**
   * 创建项目时的参数契约校验器（承载 zod schema 对象本身）。
   * 类型为 `unknown` 以避免 shared 包依赖 zod；该字段非 JSON 序列化，
   * 只读视图（`CapabilityView`）会将其剥离。
   */
  paramsSchema: unknown;
  /** 该能力注入的技能目录。 */
  skillDirs: string[];
  /** 最终产物文件名，如 `final.mp4`。 */
  finalArtifact: string;
}

/**
 * 能力声明的只读视图，用于 `GET /api/capabilities`。
 * 剥离 `paramsSchema` 等非 JSON 序列化字段，仅保留纯数据。
 */
export interface CapabilityView {
  id: string;
  name: string;
  description: string;
  stages: CapabilityStageDeclaration[];
  reviewGates: PipelineStage[];
  params: CapabilityParamDeclaration[];
  skillDirs: string[];
  finalArtifact: string;
}
