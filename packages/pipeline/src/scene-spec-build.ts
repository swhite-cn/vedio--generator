import { z } from "zod";
import {
  CONTRACT_VERSION_V2,
  VideoForgeError,
  findDuplicates,
  type CopyDocV2,
  type SceneSpecV2,
  type ShotSpec,
  type ShotV2,
} from "@videoforge/shared";
import {
  assembleComponentShot,
  componentRegistry,
  type ComponentRegistry,
} from "@videoforge/template-sdk";

/**
 * scene 阶段的纯逻辑：模型输出解析、镜头选型装配与增量合并。
 * 与 Ark 调用解耦，便于单测覆盖「非法组件/参数 → 降级」的确定性行为。
 */

/** 模型为单个镜头给出的组件选择。 */
export const sceneSelectionSchema = z.object({
  // 镜头 ID，必须存在于 copy v2
  shotId: z.string().trim().min(1),
  // 组件注册表 ID
  componentId: z.string().trim().min(1),
  // 组件参数
  props: z.record(z.string(), z.unknown()).default({}),
});

/** 模型输出的选型响应。 */
export const sceneSelectionResponseSchema = z.object({
  // 逐镜头的组件选择
  shots: z.array(sceneSelectionSchema),
});

/** 单个镜头的组件选择类型。 */
export type SceneSelection = z.infer<typeof sceneSelectionSchema>;

/**
 * 把组件注册表格式化为提示词中的可用组件清单。
 * @param registry 组件注册表
 * @returns 多行文本（ID / 名称 / 类别 / 参数约束）
 */
export function formatComponentCatalog(registry: ComponentRegistry = componentRegistry): string {
  return registry
    .list()
    .map((entry) => {
      const params = Object.entries(entry.paramsSchema)
        .map(([name, spec]) => {
          const pieces: string[] = [spec.type];
          if (spec.required) pieces.push("必填");
          if (spec.maxLength !== undefined) pieces.push(`≤${spec.maxLength}字`);
          if (spec.enumValues) pieces.push(`取值[${spec.enumValues.join("/")}]`);
          return `${name}: ${pieces.join(" ")}`;
        })
        .join("；");
      return `- ${entry.id}（${entry.category}，${entry.name}）：${params || "无参数"}`;
    })
    .join("\n");
}

/**
 * 从模型输出解析选型响应（容忍 ```json 围栏）。
 * @param text 模型原始输出
 * @returns 镜头选型列表
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 非 JSON、结构非法或 shotId 重复时
 */
export function parseSceneSelectionJson(text: string): SceneSelection[] {
  const cleaned = text
    .replace(/^```(?:json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "场景选型模型未输出合法 JSON");
  }
  const result = sceneSelectionResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `场景选型 JSON 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const duplicated = findDuplicates(result.data.shots.map((selection) => selection.shotId));
  if (duplicated.length > 0) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `场景选型的 shotId 重复：${duplicated.join(", ")}`,
    );
  }
  return result.data.shots;
}

/** 装配镜头规格的入参。 */
export interface BuildShotSpecsInput {
  /** copy v2 文档 */
  copy: CopyDocV2;
  /** 模型给出的组件选择 */
  selections: readonly SceneSelection[];
  /** 只装配这些镜头；缺省装配全片 */
  shotIds?: readonly string[];
  /** 组件注册表 */
  registry?: ComponentRegistry;
  /** 组件动效时长（300–800ms），缺省 400ms */
  animationDurationMs?: number;
}

/** 装配结果。 */
export interface BuildShotSpecsResult {
  /** 已装配的镜头规格（顺序与 copy 一致） */
  shots: ShotSpec[];
  /** 走了降级路径的镜头 ID */
  fallbackShotIds: string[];
}

/**
 * 把 copy 镜头与模型选型装配成 SceneSpec 镜头规格。
 * - visualType=component：优先模型选型，其次 copy 中手工指定的 component；都不可用时降级关键词块；
 * - 其余视觉类型：不选组件，保留 copy 的资产引用/转场/来源，动效交渲染层默认策略。
 * @param input copy、选型、镜头范围与注册表
 * @returns 镜头规格与降级镜头列表
 */
export function buildShotSpecs(input: BuildShotSpecsInput): BuildShotSpecsResult {
  const registry = input.registry ?? componentRegistry;
  const durationMs = input.animationDurationMs ?? 400;
  const selectionByShot = new Map(input.selections.map((selection) => [selection.shotId, selection]));
  const scope = input.shotIds ? new Set(input.shotIds) : null;

  const shots: ShotSpec[] = [];
  const fallbackShotIds: string[] = [];

  for (const scene of input.copy.scenes) {
    for (const shot of scene.shots) {
      if (scope && !scope.has(shot.shotId)) continue;
      const base = {
        // copy 已回填的资产引用
        assetRefs: shot.assetRefs,
        // copy 的入场/出场转场
        transition: { in: shot.transitionIn, out: shot.transitionOut },
        // copy 的来源信息
        source: shot.sourceRef ?? null,
      };

      if (shot.visualType !== "component") {
        shots.push({
          shotId: shot.shotId,
          visualType: shot.visualType,
          props: {},
          animations: [],
          ...base,
        });
        continue;
      }

      const selection =
        selectionByShot.get(shot.shotId) ?? copyPreselection(shot);
      if (selection) {
        try {
          const assembled = assembleComponentShot(
            {
              shotId: shot.shotId,
              componentId: selection.componentId,
              props: selection.props,
              animationDurationMs: durationMs,
            },
            registry,
          );
          shots.push({ ...assembled, ...base });
          continue;
        } catch (err) {
          console.info(
            `[scene:gen] 镜头 ${shot.shotId} 选型不可用，降级关键词块：${(err as Error).message}`,
          );
        }
      }

      const fallback = buildKeywordFallback(shot, base, registry, durationMs);
      if (fallback) {
        shots.push(fallback);
      } else {
        // 注册表没有关键词块（自定义注册表）时，退化为 image 镜头，保证 spec 仍可装配
        shots.push({
          shotId: shot.shotId,
          visualType: "image",
          props: {},
          animations: [],
          ...base,
        });
      }
      fallbackShotIds.push(shot.shotId);
    }
  }

  return { shots, fallbackShotIds };
}

/** 从 copy 镜头里取手工指定的组件选择（若有）。 */
function copyPreselection(shot: ShotV2): SceneSelection | undefined {
  if (!shot.component) return undefined;
  return {
    shotId: shot.shotId,
    componentId: shot.component.id,
    props: shot.component.params,
  };
}

/**
 * 构造关键词块降级规格：标题取屏上文字（或口播）并截断到 18 字。
 * @param shot copy 镜头
 * @param base 资产引用、转场与来源
 * @param registry 组件注册表
 * @param durationMs 动效时长
 * @returns 降级镜头规格；注册表无关键词块时返回 undefined
 */
function buildKeywordFallback(
  shot: ShotV2,
  base: Pick<ShotSpec, "assetRefs" | "transition" | "source">,
  registry: ComponentRegistry,
  durationMs: number,
): ShotSpec | undefined {
  if (!registry.get("keyword-block")) return undefined;
  const title = Array.from(shot.onScreenText?.trim() || shot.narration).slice(0, 18).join("");
  try {
    return {
      ...assembleComponentShot(
        { shotId: shot.shotId, componentId: "keyword-block", props: { title }, animationDurationMs: durationMs },
        registry,
      ),
      ...base,
    };
  } catch {
    return undefined;
  }
}

/**
 * 增量合并 SceneSpec：保留未参与的镜头，替换本次装配的同 ID 镜头，新镜头追加在末尾。
 * @param existing 已有 SceneSpec（可为 null）
 * @param nextShots 本次装配的镜头
 * @param themeId 生效主题 ID
 * @returns 合并后的 SceneSpec
 */
export function mergeSceneSpecShots(
  existing: SceneSpecV2 | null,
  nextShots: readonly ShotSpec[],
  themeId: string,
): SceneSpecV2 {
  const nextById = new Map(nextShots.map((shot) => [shot.shotId, shot]));
  const merged: ShotSpec[] = (existing?.shots ?? []).map(
    (shot) => nextById.get(shot.shotId) ?? shot,
  );
  for (const shot of nextShots) {
    if (!merged.some((candidate) => candidate.shotId === shot.shotId)) merged.push(shot);
  }
  return {
    contractVersion: CONTRACT_VERSION_V2,
    themeId,
    shots: merged,
  };
}
