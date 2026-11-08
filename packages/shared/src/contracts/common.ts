import { z } from "zod";

/** 契约 v2 的版本字面量；所有 v2 文档必须显式携带。 */
export const CONTRACT_VERSION_V2 = "2.0" as const;

/** v2 契约版本 schema。 */
export const contractVersionSchema = z.literal(CONTRACT_VERSION_V2);

/** 转场类型枚举（只允许三型，禁止第 4 种）。 */
export const TRANSITION_TYPES = ["hard-cut", "title-card", "fade-120"] as const;

/** 转场类型 schema。 */
export const transitionSchema = z.enum(TRANSITION_TYPES);

/** 资产在镜头中的用途。 */
export const ASSET_ROLES = ["background", "symbol", "foreground", "overlay"] as const;

/** 资产用途 schema。 */
export const assetRoleSchema = z.enum(ASSET_ROLES);

/**
 * 镜头对项目资产的结构化引用；只存 assetId 与用途，不存裸路径。
 */
export const assetRefSchema = z.object({
  // 项目资产 ID（project_assets.id）
  assetId: z.string().trim().min(1),
  // 资产用途：背景 / 符号 / 前景 / 叠加
  role: assetRoleSchema.default("background"),
});

/** 资产引用类型。 */
export type AssetRef = z.infer<typeof assetRefSchema>;

/**
 * 来源信息；数据类镜头必须提供，用来生成来源标签并做质检。
 */
export const sourceRefSchema = z.object({
  // 来源展示文案，例如「CERN 公开资料」
  label: z.string().trim().min(1),
  // 可选来源链接；不要求可访问，但必须是字符串
  url: z.string().trim().url().optional(),
  // 可选补充说明，例如「数据截至 2024 年」
  note: z.string().trim().optional(),
});

/** 来源信息类型。 */
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * 风格锚：跨镜头复用的符号资产与固定 seed，保证同一符号在全片一致。
 */
export const styleAnchorSchema = z.object({
  // 符号键，例如 proton / neutron / mercury / gold
  key: z.string().trim().min(1),
  // 符号展示名，例如「质子」
  label: z.string().trim().min(1),
  // 符号主题色，必须是 #RRGGBB
  color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "color 必须是 #RRGGBB"),
  // 可选绑定的项目资产 ID；未绑定时由 image 阶段生成并回填
  assetId: z.string().trim().min(1).optional(),
  // 可选：image 阶段生成后的项目内相对路径（POSIX `/`）；由流水线回填
  assetPath: z.string().trim().min(1).optional(),
  // 可选：图像生成 seed；同一符号跨镜头复用同一 seed
  seed: z.number().int().min(0).optional(),
});

/** 风格锚类型。 */
export type StyleAnchor = z.infer<typeof styleAnchorSchema>;

/**
 * 校验一组文本是否唯一；返回重复项列表。
 * @param values 待校验文本数组
 * @returns 去重后仍重复的值
 */
export function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}


