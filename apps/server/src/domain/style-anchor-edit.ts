import {
  VideoForgeError,
  copyDocV2Schema,
  styleAnchorSchema,
  type CopyDocV2,
  type StyleAnchor,
} from "@videoforge/shared";

/**
 * 风格锚运营的纯逻辑（T401）：
 * - 绑定/解绑项目资产、编辑 seed 与展示字段；
 * - 计算锚点被哪些镜头引用（写入项目资产 metadata 缓存与 SSE 载荷）；
 * - 显式重建（清空已生成资产路径，让下一次 image 阶段重新生成）。
 *
 * 不读写文件、不依赖数据库，便于单测覆盖非法 key / 非法 seed / 不可变原文档。
 */

/** 允许通过 PATCH 修改的风格锚字段；`null` 表示清除对应绑定或 seed。 */
export interface StyleAnchorPatchChanges {
  /** 展示名；非空字符串 */
  label?: string;
  /** 主题色，必须 #RRGGBB */
  color?: string;
  /** 图像生成 seed；null 表示清除，恢复为 image 阶段稳定派生值 */
  seed?: number | null;
  /** 绑定的项目资产 ID；null 表示解绑 */
  assetId?: string | null;
  /** 绑定资产的项目内相对路径；仅在 assetId 非空时允许 */
  assetPath?: string | null;
}

/** 应用风格锚变更的结果。 */
export interface ApplyStyleAnchorResult {
  /** 修改后的 copy（原入参不变） */
  copy: CopyDocV2;
  /** 修改前的锚点快照（用于回滚与 diff 展示） */
  before: StyleAnchor;
  /** 修改后的锚点 */
  after: StyleAnchor;
}

/** seed 上限（与 Ark/图像生成的可接受区间保持一致）。 */
const MAX_SEED = 2147483646;

/**
 * 在全片中按 key 查找风格锚。
 * @param copy copy v2 文档
 * @param key 风格锚 key
 * @returns 命中锚点；不存在返回 undefined
 */
export function findStyleAnchor(copy: CopyDocV2, key: string): StyleAnchor | undefined {
  return copy.styleAnchors.find((anchor) => anchor.key === key);
}

/**
 * 计算引用某个风格锚的镜头 ID（按 copy 顺序）。
 * @param copy copy v2 文档
 * @param key 风格锚 key
 * @returns 引用该锚点的 shotId 列表
 */
export function anchorBoundShotIds(copy: CopyDocV2, key: string): string[] {
  const ids: string[] = [];
  for (const scene of copy.scenes) {
    for (const shot of scene.shots) {
      if (shot.anchorKeys.includes(key)) ids.push(shot.shotId);
    }
  }
  return ids;
}

/**
 * 校验风格锚 key 可作为单段文件名使用，避免重建时路径越界。
 * @param key 风格锚 key
 * @returns 原样返回的合法 key
 * @throws VideoForgeError(`CONFIG_INVALID`) key 含分隔符、上跳或非法字符时
 */
export function assertAnchorKeyPathSafe(key: string): string {
  const trimmed = key.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== key ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    /[<>:"|?*\u0000-\u001f]/.test(trimmed)
  ) {
    throw new VideoForgeError("CONFIG_INVALID", "风格锚 key 非法，不能用于文件路径");
  }
  return trimmed;
}

/**
 * 校验 seed 为非负整数且不超过上限。
 * @param seed 候选 seed
 * @throws VideoForgeError(`CONFIG_INVALID`) seed 非法时
 */
function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new VideoForgeError("CONFIG_INVALID", `seed 必须是 0–${MAX_SEED} 的整数`);
  }
}

/**
 * 校验补丁至少包含一个可编辑字段。
 * @param changes 补丁
 * @throws VideoForgeError(`CONFIG_INVALID`) 无有效字段时
 */
function assertHasChanges(changes: StyleAnchorPatchChanges): void {
  const has = Object.values(changes).some((value) => value !== undefined);
  if (!has) {
    throw new VideoForgeError("CONFIG_INVALID", "风格锚补丁不能为空");
  }
}

/**
 * 应用风格锚补丁到 copy v2（不可变：返回新文档，不修改入参）。
 * @param copy 原 copy 文档
 * @param key 目标风格锚 key
 * @param changes 补丁
 * @returns 修改后的 copy 与前后快照
 * @throws VideoForgeError(`CONFIG_INVALID`) 锚点不存在、补丁为空或字段非法时
 */
export function applyStyleAnchorPatch(
  copy: CopyDocV2,
  key: string,
  changes: StyleAnchorPatchChanges,
): ApplyStyleAnchorResult {
  assertHasChanges(changes);

  const next = structuredClone(copy);
  const anchor = findStyleAnchor(next, key);
  if (!anchor) {
    throw new VideoForgeError("CONFIG_INVALID", `风格锚不存在：${key}`);
  }
  const before = structuredClone(anchor);

  if (changes.label !== undefined) {
    const label = changes.label.trim();
    if (label.length === 0) {
      throw new VideoForgeError("CONFIG_INVALID", "风格锚展示名不能为空");
    }
    anchor.label = label;
  }
  if (changes.color !== undefined) {
    anchor.color = changes.color.trim();
  }
  if (changes.seed !== undefined) {
    if (changes.seed === null) {
      delete anchor.seed;
    } else {
      assertSeed(changes.seed);
      anchor.seed = changes.seed;
    }
  }
  if (changes.assetId !== undefined) {
    if (changes.assetId === null) {
      delete anchor.assetId;
      delete anchor.assetPath;
    } else {
      const assetId = changes.assetId.trim();
      if (assetId.length === 0) {
        throw new VideoForgeError("CONFIG_INVALID", "绑定资产 ID 不能为空");
      }
      anchor.assetId = assetId;
      if (changes.assetPath !== undefined) {
        if (changes.assetPath === null) delete anchor.assetPath;
        else anchor.assetPath = changes.assetPath;
      }
    }
  } else if (changes.assetPath !== undefined) {
    // 路径只能随绑定一起出现，避免出现“有路径无资产”的半绑定状态
    throw new VideoForgeError("CONFIG_INVALID", "assetPath 只能与 assetId 一起提交");
  }

  const anchorParsed = styleAnchorSchema.safeParse(anchor);
  if (!anchorParsed.success) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `风格锚字段非法：${anchorParsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const docParsed = copyDocV2Schema.safeParse(next);
  if (!docParsed.success) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `风格锚补丁结果不符合 copy v2 契约：${docParsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { copy: docParsed.data, before, after: structuredClone(anchor) };
}

/**
 * 显式重建风格锚：清空已生成资产绑定，让下一次 image 阶段重新生成。
 * @param copy 原 copy 文档
 * @param key 目标风格锚 key
 * @param seed 可选新 seed；undefined 保留原 seed，null 清除 seed
 * @returns 修改后的 copy 与前后快照
 * @throws VideoForgeError(`CONFIG_INVALID`) 锚点不存在或 seed 非法时
 */
export function applyStyleAnchorRebuild(
  copy: CopyDocV2,
  key: string,
  seed?: number | null,
): ApplyStyleAnchorResult {
  const next = structuredClone(copy);
  const anchor = findStyleAnchor(next, key);
  if (!anchor) {
    throw new VideoForgeError("CONFIG_INVALID", `风格锚不存在：${key}`);
  }
  const before = structuredClone(anchor);

  delete anchor.assetId;
  delete anchor.assetPath;
  if (seed !== undefined) {
    if (seed === null) {
      delete anchor.seed;
    } else {
      assertSeed(seed);
      anchor.seed = seed;
    }
  }

  const docParsed = copyDocV2Schema.safeParse(next);
  if (!docParsed.success) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `风格锚重建结果不符合 copy v2 契约：${docParsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { copy: docParsed.data, before, after: structuredClone(anchor) };
}
