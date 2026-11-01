import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityDeclaration, PipelineStage } from "@videoforge/shared";
import { listStageArtifacts, verifyStageArtifact } from "../workflow/breakpoint.js";

/**
 * 项目产物索引构建（见设计文档 §4.2「产物索引」）。
 * 复用断点模块的产物判据解释器，按能力声明的阶段顺序列出实际命中的产物文件。
 */

/** 产物清单中的一条。 */
export interface ArtifactEntry {
  stage: PipelineStage;
  /** 阶段展示名（来自能力声明）。 */
  label: string;
  /** 相对项目目录的路径（POSIX `/` 分隔）。 */
  relativePath: string;
  /** 文件字节数；取不到时为 0。 */
  sizeBytes: number;
}

/** 项目产物索引（见设计文档 §4.2「产物索引」）。 */
export interface ArtifactIndex {
  /** `final.mp4` 是否存在（`done` 的唯一判据，见设计文档 §8.4）。 */
  finalVideoExists: boolean;
  entries: ArtifactEntry[];
}

/**
 * 扫描项目目录构建产物索引：按能力声明的阶段顺序，逐阶段列出实际命中的产物文件。
 * @param projectDir 项目绝对目录（必须已由 resolveUserProjectDir 校验过）
 * @param capability 能力声明（提供阶段顺序、展示名与产物判据）
 * @param profile 输出 Profile 名（用于替换 glob 中的 <profile>）
 * @returns 产物索引
 */
export function buildArtifactIndex(
  projectDir: string,
  capability: CapabilityDeclaration,
  profile: string,
): ArtifactIndex {
  const entries: ArtifactEntry[] = [];
  for (const stage of capability.stages) {
    const relativePaths = listStageArtifacts(projectDir, stage.artifact, profile);
    for (const relativePath of relativePaths) {
      let sizeBytes = 0;
      try {
        // 相对路径来自项目目录内的枚举结果，用 resolve 组装绝对路径（非字符串拼接）
        sizeBytes = statSync(resolve(projectDir, relativePath)).size;
      } catch {
        // 取不到大小（竞态删除等）按 0 处理，不影响清单可用性
        sizeBytes = 0;
      }
      entries.push({ stage: stage.stage, label: stage.label, relativePath, sizeBytes });
    }
  }

  const finalVideoExists = verifyStageArtifact(
    projectDir,
    { kind: "file", relativePath: capability.finalArtifact },
    profile,
  );

  return { finalVideoExists, entries };
}
