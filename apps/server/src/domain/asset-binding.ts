import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectVisualCategory } from "@videoforge/shared";
import { PROJECT_VISUAL_CATEGORIES, VideoForgeError } from "@videoforge/shared";
import { readCopyDocument } from "@videoforge/pipeline";

/**
 * 素材库辅助逻辑（T118）：
 * - 「已绑定 N 镜头」由 copy v2 的 `assetRefs` 与 `styleAnchors[].assetId` 计算，前端不推导；
 * - 上传/筛选时的 6 类分类解析与校验收口在此。
 */

/**
 * 校验并归一化素材分类查询参数。
 * @param value 原始值（可空）
 * @returns 合法分类或 undefined
 * @throws VideoForgeError(`ASSET_INVALID`) 分类不在 6 类枚举内时
 */
export function parseVisualCategory(value: unknown): ProjectVisualCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value === "string" &&
    (PROJECT_VISUAL_CATEGORIES as readonly string[]).includes(value)
  ) {
    return value as ProjectVisualCategory;
  }
  throw new VideoForgeError("ASSET_INVALID", `素材分类非法，可选值：${PROJECT_VISUAL_CATEGORIES.join("、")}`);
}

/**
 * 统计 copy v2 中每个资产 ID 被绑定的镜头数。
 * 计数来源：镜头 `assetRefs[].assetId` + 风格锚 `styleAnchors[].assetId`（锚点视为绑定其出现过的镜头集合，此处按引用次数计）。
 * @param projectDir 项目工作目录（读取 copy.json）
 * @returns assetId → 绑定镜头数；v1 项目或 copy 缺失时为空对象
 */
export function assetBindingCounts(projectDir: string): Record<string, number> {
  const copyPath = join(projectDir, "copy.json");
  if (!existsSync(copyPath)) return {};

  const document = readCopyDocument(copyPath);
  if (document.version !== "2") return {};

  const counts: Record<string, number> = {};
  const bump = (assetId: string): void => {
    counts[assetId] = (counts[assetId] ?? 0) + 1;
  };
  for (const anchor of document.doc.styleAnchors) {
    if (anchor.assetId) bump(anchor.assetId);
  }
  for (const scene of document.doc.scenes) {
    for (const shot of scene.shots) {
      for (const ref of shot.assetRefs) bump(ref.assetId);
    }
  }
  return counts;
}
