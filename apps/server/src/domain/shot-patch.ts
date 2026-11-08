import { z } from "zod";
import {
  CONTRACT_VERSION_V2,
  VideoForgeError,
  copyDocV2Schema,
  sourceRefSchema,
  transitionSchema,
  type ComponentSelection,
  type CopyDocV2,
  type SceneSpecV2,
  type ShotSpec,
  type ShotV2,
  type SourceRef,
} from "@videoforge/shared";
import {
  assembleComponentShot,
  componentRegistry,
  type ComponentRegistry,
} from "@videoforge/template-sdk";

/**
 * 镜头可逆编辑的纯逻辑：把 PATCH 变更应用到 copy v2 与已有 SceneSpec。
 * 不读写文件、不依赖数据库，便于单测覆盖「非法 shot / 非法组件参数 / 不可变原文档」。
 */

/** 转场类型。 */
type TransitionType = z.infer<typeof transitionSchema>;

/** 允许通过 PATCH 修改的镜头字段。 */
export interface ShotPatchChanges {
  /** 屏上文字（允许清空） */
  onScreenText?: string;
  /** 需要强调的词 */
  emphasis?: string[];
  /** 入场转场 */
  transitionIn?: TransitionType;
  /** 出场转场 */
  transitionOut?: TransitionType;
  /** 组件选择（ID + 参数），设置后 visualType 变为 component */
  component?: ComponentSelection;
  /** 来源信息；null 表示清空 */
  sourceRef?: SourceRef | null;
}

/** 应用补丁的结果。 */
export interface ApplyShotPatchResult {
  /** 修改后的 copy（原入参不变） */
  copy: CopyDocV2;
  /** 修改前的镜头快照（用于回滚与 diff 展示） */
  before: ShotV2;
  /** 修改后的镜头 */
  after: ShotV2;
}

/**
 * 校验补丁至少包含一个可编辑字段。
 * @param changes 补丁
 * @throws VideoForgeError(`CONFIG_INVALID`) 无有效字段时
 */
function assertHasChanges(changes: ShotPatchChanges): void {
  const has = (Object.keys(changes) as Array<keyof ShotPatchChanges>).some(
    (key) => changes[key] !== undefined,
  );
  if (!has) {
    throw new VideoForgeError("CONFIG_INVALID", "镜头补丁不能为空");
  }
}

/**
 * 按 shotId 定位镜头（全片唯一）。
 * @param copy copy v2
 * @param shotId 镜头 ID
 * @returns 命中的镜头；不存在返回 undefined
 */
function findShot(copy: CopyDocV2, shotId: string): ShotV2 | undefined {
  for (const scene of copy.scenes) {
    const shot = scene.shots.find((candidate) => candidate.shotId === shotId);
    if (shot) return shot;
  }
  return undefined;
}

/**
 * 应用镜头补丁到 copy v2（不可变：返回新文档，不修改入参）。
 * @param copy 原 copy 文档
 * @param shotId 目标镜头
 * @param changes 补丁
 * @param registry 组件注册表（缺省内置）
 * @returns 修改后的 copy 与前后快照
 * @throws VideoForgeError(`CONFIG_INVALID`) 镜头不存在、补丁为空或组件/转场/来源非法时
 */
export function applyShotPatch(
  copy: CopyDocV2,
  shotId: string,
  changes: ShotPatchChanges,
  registry: ComponentRegistry = componentRegistry,
): ApplyShotPatchResult {
  assertHasChanges(changes);

  const nextCopy = structuredClone(copy);
  const shot = findShot(nextCopy, shotId);
  if (!shot) {
    throw new VideoForgeError("CONFIG_INVALID", `镜头不存在：${shotId}`);
  }
  const before = structuredClone(shot);

  if (changes.onScreenText !== undefined) {
    shot.onScreenText = changes.onScreenText.trim();
  }
  if (changes.emphasis !== undefined) {
    shot.emphasis = [...new Set(changes.emphasis.map((word) => word.trim()).filter(Boolean))];
  }
  if (changes.transitionIn !== undefined) {
    const parsed = transitionSchema.safeParse(changes.transitionIn);
    if (!parsed.success) {
      throw new VideoForgeError("CONFIG_INVALID", `入场转场非法：${String(changes.transitionIn)}`);
    }
    shot.transitionIn = parsed.data;
  }
  if (changes.transitionOut !== undefined) {
    const parsed = transitionSchema.safeParse(changes.transitionOut);
    if (!parsed.success) {
      throw new VideoForgeError("CONFIG_INVALID", `出场转场非法：${String(changes.transitionOut)}`);
    }
    shot.transitionOut = parsed.data;
  }
  if (changes.sourceRef !== undefined) {
    if (changes.sourceRef === null) {
      shot.sourceRef = null;
    } else {
      const parsed = sourceRefSchema.safeParse(changes.sourceRef);
      if (!parsed.success) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `来源信息非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }
      shot.sourceRef = parsed.data;
    }
  }
  if (changes.component !== undefined) {
    // 组件参数在装配期强校验；非法组件/参数直接拒绝，不落盘
    registry.assertProps(changes.component.id, changes.component.params);
    shot.component = changes.component;
    shot.visualType = "component";
  }

  const validated = copyDocV2Schema.safeParse(nextCopy);
  if (!validated.success) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `镜头补丁结果不符合 copy v2 契约：${validated.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { copy: validated.data, before, after: structuredClone(shot) };
}

/**
 * 把镜头补丁同步到已有 SceneSpec（仅改该镜头；不存在该镜头时原样返回）。
 * 组件变化会重新装配动效；转场/来源直接覆盖。
 * @param spec 已有 SceneSpec
 * @param before 修改前的 copy 镜头
 * @param after 修改后的 copy 镜头
 * @param options 动效时长与组件注册表
 * @returns 新的 SceneSpec（不修改入参）
 */
export function applyShotPatchToSpec(
  spec: SceneSpecV2,
  before: ShotV2,
  after: ShotV2,
  options: { animationDurationMs?: number; registry?: ComponentRegistry } = {},
): SceneSpecV2 {
  const index = spec.shots.findIndex((shot) => shot.shotId === after.shotId);
  if (index < 0) return spec;

  const registry = options.registry ?? componentRegistry;
  const durationMs = options.animationDurationMs ?? 400;
  const current = spec.shots[index];
  let updated: ShotSpec = {
    ...current,
    transition: { in: after.transitionIn, out: after.transitionOut },
    source: after.sourceRef ?? null,
  };

  const componentChanged =
    changesComponent(before.component, after.component) || after.visualType !== before.visualType;
  if (componentChanged && after.visualType === "component" && after.component) {
    updated = {
      ...assembleComponentShot(
        {
          shotId: after.shotId,
          componentId: after.component.id,
          props: after.component.params,
          animationDurationMs: durationMs,
        },
        registry,
      ),
      transition: { in: after.transitionIn, out: after.transitionOut },
      source: after.sourceRef ?? null,
      assetRefs: current.assetRefs,
    };
  }

  const shots = spec.shots.map((shot, shotIndex) => (shotIndex === index ? updated : shot));
  return { ...spec, contractVersion: CONTRACT_VERSION_V2, shots };
}

/**
 * 判断两次组件选择是否不同（ID 或参数任一变化）。
 * @param before 修改前组件
 * @param after 修改后组件
 * @returns 是否发生变化
 */
function changesComponent(
  before: ComponentSelection | undefined,
  after: ComponentSelection | undefined,
): boolean {
  if (!before && !after) return false;
  if (!before || !after) return true;
  return (
    before.id !== after.id || JSON.stringify(before.params) !== JSON.stringify(after.params)
  );
}
