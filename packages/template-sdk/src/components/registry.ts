import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  VideoForgeError,
  componentPreviewFixtureSchema,
  componentRegistryEntrySchema,
  type ComponentCategory,
  type ComponentParamSpec,
  type ComponentPreviewFixture,
  type ComponentRegistryEntry,
  type ShotSpec,
} from "@videoforge/shared";

/**
 * 组件注册表基础设施。
 *
 * 设计约束（见方案 §5.6、§4.3）：
 * - LLM 只能按组件 ID 选型并填参数，不能输出 HTML；组件实现与流水线解耦；
 * - 新增组件只需在 `BUILTIN_COMPONENT_ENTRIES` 追加一条声明，不改 stages / pipeline / API；
 * - 参数校验发生在装配期（scene 阶段与渲染前），非法组件或参数直接报 `CONFIG_INVALID`。
 */

/** 单个参数的校验结果。 */
export interface ComponentPropValidationResult {
  /** 是否全部通过。 */
  ok: boolean;
  /** 面向用户的错误信息（空数组表示通过）。 */
  errors: string[];
}

/** 组件注册表对外能力：查询、列表与参数校验。 */
export interface ComponentRegistry {
  /** 全部组件（按注册顺序）。 */
  list(): ComponentRegistryEntry[];
  /** 按类别过滤。 */
  listByCategory(category: ComponentCategory): ComponentRegistryEntry[];
  /** 按 ID 查询；不存在返回 undefined。 */
  get(id: string): ComponentRegistryEntry | undefined;
  /** 按 ID 查询；不存在抛 `CONFIG_INVALID`。 */
  require(id: string): ComponentRegistryEntry;
  /** 校验参数；不抛异常，返回错误列表。 */
  validateProps(id: string, props: Record<string, unknown>): ComponentPropValidationResult;
  /** 校验参数；不通过时抛 `CONFIG_INVALID`。 */
  assertProps(id: string, props: Record<string, unknown>): void;
}

/**
 * 校验 preview fixture 相对路径：必须相对、不得越界。
 * 便于组件库页面按项目根安全读取预览素材。
 * @param componentId 组件 ID（错误信息用）
 * @param fixture 相对路径
 */
function assertPreviewFixture(componentId: string, fixture: string): void {
  if (isAbsolute(fixture)) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `组件 ${componentId} 的 previewFixture 必须是相对路径：${fixture}`,
    );
  }
  const segments = fixture.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `组件 ${componentId} 的 previewFixture 不允许越界：${fixture}`,
    );
  }
}

/**
 * 校验单个参数值。
 * @param name 参数名
 * @param spec 参数声明
 * @param value 实际值
 * @returns 错误信息；通过返回 null
 */
function checkParamValue(name: string, spec: ComponentParamSpec, value: unknown): string | null {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") return `参数 ${name} 必须是字符串`;
      if (spec.maxLength !== undefined && Array.from(value).length > spec.maxLength) {
        return `参数 ${name} 超过 ${spec.maxLength} 字`;
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) return `参数 ${name} 必须是数字`;
      if (spec.min !== undefined && value < spec.min) return `参数 ${name} 不能小于 ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `参数 ${name} 不能大于 ${spec.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `参数 ${name} 必须是布尔值`;
    case "enum": {
      if (typeof value !== "string") return `参数 ${name} 必须是字符串枚举`;
      const allowed = spec.enumValues ?? [];
      return allowed.includes(value) ? null : `参数 ${name} 只能取：${allowed.join(" / ")}`;
    }
    default:
      return `参数 ${name} 的类型不受支持`;
  }
}

/**
 * 创建一个组件注册表（构造期完成结构校验与 ID 去重）。
 * @param entries 组件声明数组（按注册顺序）
 * @returns 注册表实例
 * @throws VideoForgeError(`CONFIG_INVALID`) 条目结构非法、ID 重复或预览路径越界时
 */
export function createComponentRegistry(entries: readonly unknown[]): ComponentRegistry {
  const parsed: ComponentRegistryEntry[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const result = componentRegistryEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `组件注册表第 ${index + 1} 项结构非法（${result.error.issues[0]?.message ?? "unknown"}）`,
      );
    }
    const component = result.data;
    if (seen.has(component.id)) {
      throw new VideoForgeError("CONFIG_INVALID", `组件 ID 重复：${component.id}`);
    }
    seen.add(component.id);
    if (component.previewFixture) {
      assertPreviewFixture(component.id, component.previewFixture);
    }
    parsed.push(component);
  }

  const byId = new Map(parsed.map((component) => [component.id, component]));

  const registry: ComponentRegistry = {
    list: () => [...parsed],
    listByCategory: (category) => parsed.filter((component) => component.category === category),
    get: (id) => byId.get(id),
    require: (id) => {
      const component = byId.get(id);
      if (!component) {
        throw new VideoForgeError("CONFIG_INVALID", `未知组件：${id}`);
      }
      return component;
    },
    validateProps: (id, props) => {
      const component = byId.get(id);
      if (!component) {
        return { ok: false, errors: [`未知组件：${id}`] };
      }
      const errors: string[] = [];
      const specNames = Object.keys(component.paramsSchema);
      for (const name of Object.keys(props)) {
        if (!specNames.includes(name)) errors.push(`参数 ${name} 不属于组件 ${id}`);
      }
      for (const [name, spec] of Object.entries(component.paramsSchema)) {
        const value = props[name];
        if (value === undefined || value === null) {
          if (spec.required) errors.push(`缺少必填参数 ${name}`);
          continue;
        }
        const failure = checkParamValue(name, spec, value);
        if (failure) errors.push(failure);
      }
      return { ok: errors.length === 0, errors };
    },
    assertProps: (id, props) => {
      if (!byId.has(id)) {
        throw new VideoForgeError("CONFIG_INVALID", `未知组件：${id}`);
      }
      const result = registry.validateProps(id, props);
      if (!result.ok) {
        throw new VideoForgeError(
          "CONFIG_INVALID",
          `组件 ${id} 参数非法：${result.errors.join("；")}`,
        );
      }
    },
  };
  return registry;
}

/** 组件预览 fixture 所在目录（相对仓库根目录）。 */
export const COMPONENT_CONFIG_RELATIVE_DIR = "config/components";

/**
 * 内置组件声明（由代码注册，不手改 JSON）。
 * T109 注册 3 类高频组件；T203 补齐其余 4 类（对比条/进度环/章节角标/来源标签）。
 */
export const BUILTIN_COMPONENT_ENTRIES: readonly ComponentRegistryEntry[] = [
  {
    id: "keyword-block",
    name: "关键词块",
    category: "text",
    coverageNote: "参考片占比 28%",
    paramsSchema: {
      // 屏上主标题，最多 18 字
      title: { type: "string", required: true, maxLength: 18 },
      // 副标题，最多 28 字
      subtitle: { type: "string", required: false, maxLength: 28 },
      // 强调下划线动效
      underline: { type: "enum", required: false, enumValues: ["none", "sweep", "grow"] },
    },
    animations: ["title-in", "underline-sweep"],
    previewFixture: "fixtures/keyword-block.json",
  },
  {
    id: "data-card",
    name: "数据卡",
    category: "data",
    paramsSchema: {
      // 指标名，最多 12 字
      label: { type: "string", required: true, maxLength: 12 },
      // 数值文本（含千分位/小数），最多 12 字
      value: { type: "string", required: true, maxLength: 12 },
      // 单位，最多 6 字
      unit: { type: "string", required: false, maxLength: 6 },
      // 统计口径/时间范围，最多 20 字
      caption: { type: "string", required: false, maxLength: 20 },
      // 趋势箭头
      trend: { type: "enum", required: false, enumValues: ["up", "down", "flat"] },
    },
    animations: ["card-rise", "number-count"],
    previewFixture: "fixtures/data-card.json",
  },
  {
    id: "quote-card",
    name: "引语卡",
    category: "quote",
    paramsSchema: {
      // 引语正文，最多 48 字
      quote: { type: "string", required: true, maxLength: 48 },
      // 引语主体，最多 20 字
      author: { type: "string", required: false, maxLength: 20 },
      // 身份/出处，最多 24 字
      role: { type: "string", required: false, maxLength: 24 },
      // 需要高亮的词，最多 12 字
      emphasis: { type: "string", required: false, maxLength: 12 },
    },
    animations: ["quote-fade", "quote-mark-in"],
    previewFixture: "fixtures/quote-card.json",
  },
  {
    id: "comparison-bars",
    name: "对比条",
    category: "compare",
    paramsSchema: {
      // A 组名称，最多 12 字
      labelA: { type: "string", required: true, maxLength: 12 },
      // A 组数值文本，最多 12 字
      valueA: { type: "string", required: true, maxLength: 12 },
      // B 组名称，最多 12 字
      labelB: { type: "string", required: true, maxLength: 12 },
      // B 组数值文本，最多 12 字
      valueB: { type: "string", required: true, maxLength: 12 },
      // 单位，最多 6 字
      unit: { type: "string", required: false, maxLength: 6 },
      // 对比口径说明，最多 20 字
      caption: { type: "string", required: false, maxLength: 20 },
    },
    animations: ["bars-grow"],
    previewFixture: "fixtures/comparison-bars.json",
  },
  {
    id: "progress-ring",
    name: "进度环",
    category: "progress",
    paramsSchema: {
      // 指标名，最多 12 字
      label: { type: "string", required: true, maxLength: 12 },
      // 百分比 0–100
      percent: { type: "number", required: true, min: 0, max: 100 },
      // 数值单位文本，最多 6 字（缺省显示 %）
      unit: { type: "string", required: false, maxLength: 6 },
      // 口径说明，最多 20 字
      caption: { type: "string", required: false, maxLength: 20 },
    },
    animations: ["ring-fill"],
    previewFixture: "fixtures/progress-ring.json",
  },
  {
    id: "chapter-badge",
    name: "章节角标",
    category: "chapter",
    paramsSchema: {
      // 章节号（如 02），最多 6 字
      chapter: { type: "string", required: true, maxLength: 6 },
      // 章节标题，最多 16 字
      title: { type: "string", required: true, maxLength: 16 },
      // 章节副题，最多 24 字
      subtitle: { type: "string", required: false, maxLength: 24 },
    },
    animations: ["badge-in"],
    previewFixture: "fixtures/chapter-badge.json",
  },
  {
    id: "source-tag",
    name: "来源标签",
    category: "source",
    paramsSchema: {
      // 来源展示文案，最多 20 字
      label: { type: "string", required: true, maxLength: 20 },
      // 补充说明（如「数据截至 2024 年」），最多 40 字
      note: { type: "string", required: false, maxLength: 40 },
    },
    animations: ["fade-in"],
    previewFixture: "fixtures/source-tag.json",
  },
];

/** 默认组件注册表（服务端 `/api/components` 与 scene 阶段共用）。 */
export const componentRegistry: ComponentRegistry = createComponentRegistry(
  BUILTIN_COMPONENT_ENTRIES,
);

/**
 * 读取并校验组件预览 fixture（`config/components/<previewFixture>`）。
 * fixture 的 `componentId` 必须与请求组件一致，`props` 必须通过该组件参数校验。
 * @param rootDir 仓库根目录
 * @param componentId 组件 ID
 * @param registry 注册表（缺省用内置注册表）
 * @returns 合法 fixture
 * @throws VideoForgeError(`CONFIG_INVALID`) 组件未登记 fixture、文件缺失、ID 不一致或参数非法时
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) fixture 非 JSON 或结构非法时
 */
export function readComponentPreviewFixture(
  rootDir: string,
  componentId: string,
  registry: ComponentRegistry = componentRegistry,
): ComponentPreviewFixture {
  const entry = registry.require(componentId);
  if (!entry.previewFixture) {
    throw new VideoForgeError("CONFIG_INVALID", `组件 ${componentId} 未登记 previewFixture`);
  }

  const path = join(rootDir, COMPONENT_CONFIG_RELATIVE_DIR, entry.previewFixture);
  if (!existsSync(path)) {
    throw new VideoForgeError("CONFIG_INVALID", `组件预览 fixture 不存在：${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `组件预览 fixture 解析失败：${path}（${(err as Error).message}）`,
    );
  }

  const result = componentPreviewFixtureSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `组件预览 fixture 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  const fixture = result.data;
  if (fixture.componentId !== componentId) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `组件预览 fixture 的 componentId 不一致：期望 ${componentId}，实际 ${fixture.componentId}`,
    );
  }

  const propsResult = registry.validateProps(componentId, fixture.props);
  if (!propsResult.ok) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `组件 ${componentId} 的预览 fixture 参数非法：${propsResult.errors.join("；")}`,
    );
  }
  return fixture;
}

/** 装配一个组件镜头所需的入参。 */
export interface AssembleComponentShotInput {
  /** 镜头 ID（scene 阶段来自 copy v2；预览可用 preview） */
  shotId: string;
  /** 组件 ID */
  componentId: string;
  /** 组件参数（装配期做强校验） */
  props: Record<string, unknown>;
  /** 动效时长覆盖，300–800ms，缺省 400ms */
  animationDurationMs?: number;
}

/**
 * 把「组件 ID + 参数」装配成 SceneSpec 的单镜头规格。
 * LLM 只负责选型与填参，这里统一补齐动效、转场与资产占位，非法组件或参数直接拒绝。
 * @param input 镜头、组件与参数
 * @param registry 注册表（缺省用内置注册表）
 * @returns 单镜头视觉规格
 * @throws VideoForgeError(`CONFIG_INVALID`) 未知组件、参数非法或动效时长越界时
 */
export function assembleComponentShot(
  input: AssembleComponentShotInput,
  registry: ComponentRegistry = componentRegistry,
): ShotSpec {
  const entry = registry.require(input.componentId);
  registry.assertProps(input.componentId, input.props);

  const durationMs = input.animationDurationMs ?? 400;
  if (durationMs < 300 || durationMs > 800) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `动效时长必须在 300–800ms：${durationMs}`,
    );
  }

  return {
    shotId: input.shotId,
    visualType: "component",
    componentId: entry.id,
    props: input.props,
    assetRefs: [],
    transition: { in: "hard-cut", out: "hard-cut" },
    animations: entry.animations.map((effect, index) => ({
      effect,
      atMs: index * 100,
      durationMs,
    })),
    source: null,
  };
}
