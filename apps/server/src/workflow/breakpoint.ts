import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactPredicate, CapabilityDeclaration, PipelineStage } from "@videoforge/shared";
import { assertInsideUserRoot, readCopyDoc } from "@videoforge/pipeline";

// ---------------------------------------------------------------------------
// 产物判据解释器与断点扫描，见设计文档 §6.1、§6.5。
// 判据来源为能力声明（`CapabilityStageDeclaration.artifact`），本模块不含阶段知识。
// 所有文件 IO 失败一律按「未达标」处理（返回 false），不向上抛错——断点是软判据。
// ---------------------------------------------------------------------------

/**
 * 将相对项目目录的路径解析为绝对路径，并复用 `assertInsideUserRoot` 复核未越界
 * （不采用字符串拼接构造敏感路径）。
 * @param projectDir 项目根目录（绝对路径）
 * @param relativePath 相对项目目录的路径
 * @returns 安全的绝对路径
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) 目标越出项目目录时
 */
function resolveProjectPath(projectDir: string, relativePath: string): string {
  const target = resolve(projectDir, relativePath);
  assertInsideUserRoot(projectDir, target);
  return target;
}

/**
 * 把 glob 模式的最后一段（文件名段）转成正则（最小实现，仅支持 `*` 与 `?`）。
 * 本能力声明的模式全部形如 `<dir>/*.<ext>`，无需 `**` 递归匹配。
 * @param segment 文件名段（如 `*.jpg`）
 * @returns 匹配文件名的正则
 */
function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

/**
 * 统计 glob 模式在项目目录内命中的文件数（仅计数文件，不含子目录）。
 * 模式以最后一个 `/` 拆分为目录段与文件名段；无 `/` 时目录段为项目根。
 * @param projectDir 项目根目录（绝对路径）
 * @param pattern 已替换过 `<profile>` 的 glob 模式
 * @returns 命中的文件数量
 * @throws 目录不存在等 IO 错误由调用方捕获
 */
function countGlobMatches(projectDir: string, pattern: string): number {
  const slashIndex = pattern.lastIndexOf("/");
  const dirPart = slashIndex >= 0 ? pattern.slice(0, slashIndex) : ".";
  const filePart = slashIndex >= 0 ? pattern.slice(slashIndex + 1) : pattern;
  const dir = resolveProjectPath(projectDir, dirPart);
  const matcher = globSegmentToRegExp(filePart);
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && matcher.test(entry.name)).length;
}

/**
 * 校验单个阶段的产物判据是否达标（见设计文档 §6.1：完成判据 = 产物存在且通过契约校验）。
 *
 * 受控偏差：`validator:"timeline-contract"` 降级为「文件存在且内容可被 `JSON.parse`」——
 * 本仓库目前尚无 timeline 契约校验器，故先用 JSON 可解析作为最小判据；待 timeline 契约落地后替换。
 *
 * 所有异常（路径越界、文件缺失、内容非法、目录不可读）统一按未达标处理，返回 `false`。
 * @param projectDir 项目根目录（绝对路径）
 * @param predicate 阶段产物判据
 * @param profile 输出 Profile 名（用于替换 glob 模式中的 `<profile>` 占位符）
 * @returns 达标返回 `true`，否则 `false`
 */
export function verifyStageArtifact(
  projectDir: string,
  predicate: ArtifactPredicate,
  profile: string,
): boolean {
  try {
    if (predicate.kind === "file") {
      const target = resolveProjectPath(projectDir, predicate.relativePath);
      if (!existsSync(target)) return false;
      if (predicate.validator === "copy-contract") {
        readCopyDoc(target);
      } else if (predicate.validator === "timeline-contract") {
        // 受控偏差：无 timeline 契约校验器，降级为 JSON 可解析
        JSON.parse(readFileSync(target, "utf-8"));
      }
      return true;
    }

    const pattern = predicate.pattern.replaceAll("<profile>", profile);
    return countGlobMatches(projectDir, pattern) >= predicate.minCount;
  } catch (err) {
    console.warn(`[workflow-breakpoint] artifact check not satisfied: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 列出某阶段产物判据实际命中的产物相对路径（相对项目目录，POSIX `/` 分隔）。
 * 供产物清单 API 使用；任何 IO 异常（目录不存在、路径越界等）一律按「无产物」处理，返回空数组。
 * @param projectDir 项目根目录（绝对路径）
 * @param predicate 阶段产物判据
 * @param profile 输出 Profile 名（用于替换 glob 模式中的 `<profile>` 占位符）
 * @returns 命中的产物相对路径数组（glob 结果按文件名排序，保证稳定）
 */
export function listStageArtifacts(
  projectDir: string,
  predicate: ArtifactPredicate,
  profile: string,
): string[] {
  try {
    if (predicate.kind === "file") {
      // 只判存在，不要求契约校验通过
      const target = resolveProjectPath(projectDir, predicate.relativePath);
      return existsSync(target) ? [predicate.relativePath] : [];
    }

    // glob：替换 <profile> 后按最后一个 `/` 拆目录段 / 文件名段（无 `/` 时目录段为 "."）
    const pattern = predicate.pattern.replaceAll("<profile>", profile);
    const slashIndex = pattern.lastIndexOf("/");
    const dirPart = slashIndex >= 0 ? pattern.slice(0, slashIndex) : ".";
    const filePart = slashIndex >= 0 ? pattern.slice(slashIndex + 1) : pattern;
    const dir = resolveProjectPath(projectDir, dirPart);
    const matcher = globSegmentToRegExp(filePart);
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => (dirPart === "." ? entry.name : `${dirPart}/${entry.name}`))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn(`[workflow-breakpoint] listStageArtifacts failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 断点扫描（见设计文档 §6.5）：按能力声明的阶段顺序扫描产物，返回续跑起点。
 * 从第一个未达标阶段开始返回其下标；此前所有达标阶段收入 `skipped`；
 * 全部达标时 `startIndex = stages.length` 且 `skipped` 为全部阶段。
 * 以「产物文件存在且通过判据」为唯一断点依据。
 * @param projectDir 项目根目录（绝对路径）
 * @param declaration 能力声明（提供阶段顺序与各阶段产物判据）
 * @param profile 输出 Profile 名
 * @returns `startIndex` 续跑起点下标；`skipped` 已达标（可跳过）的阶段列表
 */
export function resolveBreakpoint(
  projectDir: string,
  declaration: CapabilityDeclaration,
  profile: string,
): { startIndex: number; skipped: PipelineStage[] } {
  const skipped: PipelineStage[] = [];
  for (let index = 0; index < declaration.stages.length; index += 1) {
    const stageDeclaration = declaration.stages[index];
    if (!verifyStageArtifact(projectDir, stageDeclaration.artifact, profile)) {
      console.info(
        `[workflow-breakpoint] resume from stage: ${stageDeclaration.stage} (index ${index})`,
      );
      return { startIndex: index, skipped };
    }
    skipped.push(stageDeclaration.stage);
  }
  return { startIndex: declaration.stages.length, skipped };
}
