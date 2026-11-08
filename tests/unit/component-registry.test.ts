import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUILTIN_COMPONENT_ENTRIES,
  COMPONENT_CONFIG_RELATIVE_DIR,
  assembleComponentShot,
  componentRegistry,
  createComponentRegistry,
  readComponentPreviewFixture,
} from "../../packages/template-sdk/src/index";

/** 仓库根目录（真实 config/components 所在位置）。 */
const repoRoot = process.cwd();

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 建一个只含 fixture 目录的临时仓库根。 */
function makeFixtureRoot(fixtureName: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "videoforge-components-"));
  tempDirs.push(root);
  const dir = join(root, COMPONENT_CONFIG_RELATIVE_DIR, "fixtures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fixtureName), content, "utf-8");
  return root;
}

/** 一份合法的「关键词块」组件声明（T109 正式规格的最小夹具）。 */
const keywordBlock = {
  id: "keyword-block",
  name: "关键词块",
  category: "text",
  coverageNote: "参考片占比 28%",
  paramsSchema: {
    title: { type: "string", required: true, maxLength: 18 },
    subtitle: { type: "string", required: false, maxLength: 28 },
    underline: { type: "enum", enumValues: ["none", "sweep", "grow"] },
    weight: { type: "number", min: 1, max: 5 },
    highlighted: { type: "boolean" },
  },
  animations: ["title-in", "underline-sweep"],
  previewFixture: "fixtures/keyword-block.json",
};

/** 第二份组件声明，用于验证多组件注册与类别过滤。 */
const dataCard = {
  id: "data-card",
  name: "数据卡",
  category: "data",
  paramsSchema: {
    value: { type: "string", required: true, maxLength: 12 },
  },
  previewFixture: "fixtures/data-card.json",
};

describe("组件注册表：注册与查询", () => {
  test("按注册顺序列出、按 ID 查询与按类别过滤", () => {
    const registry = createComponentRegistry([keywordBlock, dataCard]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["keyword-block", "data-card"]);
    expect(registry.listByCategory("text").map((entry) => entry.id)).toEqual(["keyword-block"]);
    expect(registry.listByCategory("data").map((entry) => entry.id)).toEqual(["data-card"]);
    expect(registry.listByCategory("quote")).toEqual([]);
    expect(registry.get("data-card")?.name).toBe("数据卡");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.require("keyword-block").category).toBe("text");
  });

  test("未知组件 require 抛 CONFIG_INVALID", () => {
    const registry = createComponentRegistry([keywordBlock]);
    expect(() => registry.require("no-such")).toThrowError(/CONFIG_INVALID/);
  });

  test("组件 ID 重复时构造期抛 CONFIG_INVALID", () => {
    expect(() => createComponentRegistry([keywordBlock, { ...dataCard, id: "keyword-block" }])) //
      .toThrowError(/CONFIG_INVALID/);
  });

  test("类别不在 7 类固定枚举内时抛 CONFIG_INVALID", () => {
    expect(() =>
      createComponentRegistry([{ ...keywordBlock, category: "banner" }]),
    ).toThrowError(/CONFIG_INVALID/);
  });

  test("enum 参数缺少 enumValues 时抛 CONFIG_INVALID", () => {
    expect(() =>
      createComponentRegistry([
        {
          ...keywordBlock,
          paramsSchema: { underline: { type: "enum", required: false } },
        },
      ]),
    ).toThrowError(/CONFIG_INVALID/);
  });

  test("previewFixture 为绝对路径或越界时抛 CONFIG_INVALID", () => {
    expect(() =>
      createComponentRegistry([{ ...keywordBlock, previewFixture: "/abs/preview.json" }]),
    ).toThrowError(/CONFIG_INVALID/);
    expect(() =>
      createComponentRegistry([{ ...keywordBlock, previewFixture: "fixtures/../../secret.json" }]),
    ).toThrowError(/CONFIG_INVALID/);
  });

  test("新增组件只改注册数组即可生效，不影响已有注册表", () => {
    const before = createComponentRegistry([keywordBlock]);
    const after = createComponentRegistry([keywordBlock, dataCard]);

    expect(before.list()).toHaveLength(1);
    expect(after.list()).toHaveLength(2);
    expect(before.get("data-card")).toBeUndefined();
    expect(after.get("keyword-block")).toEqual(before.get("keyword-block"));
  });

  test("内置注册表覆盖 7 类组件（T109 三类 + T203 四类）", () => {
    expect(BUILTIN_COMPONENT_ENTRIES.map((entry) => entry.id)).toEqual([
      "keyword-block",
      "data-card",
      "quote-card",
      "comparison-bars",
      "progress-ring",
      "chapter-badge",
      "source-tag",
    ]);
    expect(componentRegistry.listByCategory("text").map((entry) => entry.name)).toEqual([
      "关键词块",
    ]);
    expect(componentRegistry.listByCategory("data").map((entry) => entry.name)).toEqual(["数据卡"]);
    expect(componentRegistry.listByCategory("quote").map((entry) => entry.name)).toEqual(["引语卡"]);
    expect(componentRegistry.listByCategory("compare").map((entry) => entry.name)).toEqual([
      "对比条",
    ]);
    expect(componentRegistry.listByCategory("progress").map((entry) => entry.name)).toEqual([
      "进度环",
    ]);
    expect(componentRegistry.listByCategory("chapter").map((entry) => entry.name)).toEqual([
      "章节角标",
    ]);
    expect(componentRegistry.listByCategory("source").map((entry) => entry.name)).toEqual([
      "来源标签",
    ]);
  });
});

describe("组件注册表：参数校验", () => {
  test("合法参数通过校验", () => {
    const registry = createComponentRegistry([keywordBlock]);
    const result = registry.validateProps("keyword-block", {
      title: "水银的两面",
      underline: "sweep",
      weight: 3,
      highlighted: true,
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("缺少必填参数与未知参数同时报错", () => {
    const registry = createComponentRegistry([keywordBlock]);
    const result = registry.validateProps("keyword-block", { color: "#FFF" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining(["缺少必填参数 title", "参数 color 不属于组件 keyword-block"]),
    );
  });

  test("字符串长度按字符数（CJK 逐字）校验", () => {
    const registry = createComponentRegistry([keywordBlock]);
    // 19 个字符超出上限
    expect(
      registry.validateProps("keyword-block", { title: "一二三四五六七八九十一二三四五六七八九" }).errors,
    ).toEqual(["参数 title 超过 18 字"]);
    // 18 个字符恰好通过
    expect(
      registry.validateProps("keyword-block", { title: "一二三四五六七八九十一二三四五六七八" }).ok,
    ).toBe(true);
  });

  test("数字边界、枚举与类型错误分别报错", () => {
    const registry = createComponentRegistry([keywordBlock]);
    const errors = registry.validateProps("keyword-block", {
      title: "标题",
      underline: "glow",
      weight: 9,
    }).errors;

    expect(errors).toEqual(
      expect.arrayContaining([
        "参数 underline 只能取：none / sweep / grow",
        "参数 weight 不能大于 5",
      ]),
    );

    expect(registry.validateProps("keyword-block", { title: 42 }).errors).toContain(
      "参数 title 必须是字符串",
    );
    expect(
      registry.validateProps("keyword-block", { title: "标题", highlighted: "yes" }).errors,
    ).toContain("参数 highlighted 必须是布尔值");
  });

  test("未知组件的 validateProps 返回失败而非抛异常", () => {
    const registry = createComponentRegistry([keywordBlock]);
    expect(registry.validateProps("no-such", {})).toEqual({
      ok: false,
      errors: ["未知组件：no-such"],
    });
  });

  test("assertProps 在参数非法时抛 CONFIG_INVALID 并给出原因", () => {
    const registry = createComponentRegistry([keywordBlock]);
    expect(() => registry.assertProps("keyword-block", {})).toThrowError(/缺少必填参数 title/);
    expect(() => registry.assertProps("no-such", {})).toThrowError(/未知组件/);
    expect(() => registry.assertProps("keyword-block", { title: "标题" })).not.toThrow();
  });
});

describe("组件预览 fixture 与装配", () => {
  test.each(["keyword-block", "data-card", "quote-card"])(
    "%s 的仓库 fixture 可读取且参数合法",
    (componentId) => {
      const fixture = readComponentPreviewFixture(repoRoot, componentId);
      expect(fixture.componentId).toBe(componentId);
      expect(componentRegistry.validateProps(componentId, fixture.props).ok).toBe(true);
    },
  );

  test("fixture 文件缺失时抛 CONFIG_INVALID", () => {
    const root = makeFixtureRoot("unrelated.json", "{}");
    expect(() => readComponentPreviewFixture(root, "keyword-block")).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("fixture 的 componentId 与请求组件不一致时抛 CONFIG_INVALID", () => {
    const root = makeFixtureRoot(
      "keyword-block.json",
      JSON.stringify({ componentId: "data-card", props: {} }),
    );
    expect(() => readComponentPreviewFixture(root, "keyword-block")).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("fixture 参数非法时抛 CONFIG_INVALID", () => {
    const root = makeFixtureRoot(
      "keyword-block.json",
      JSON.stringify({
        componentId: "keyword-block",
        props: { title: "一二三四五六七八九十一二三四五六七八九" },
      }),
    );
    expect(() => readComponentPreviewFixture(root, "keyword-block")).toThrowError(
      /参数非法/,
    );
  });

  test("fixture 非 JSON 时抛 ADAPTER_PROTOCOL_INVALID", () => {
    const root = makeFixtureRoot("keyword-block.json", "不是 JSON");
    expect(() => readComponentPreviewFixture(root, "keyword-block")).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
  });

  test("装配关键词块：固定动效、hard-cut 转场与参数校验", () => {
    const shot = assembleComponentShot({
      shotId: "sh-001",
      componentId: "keyword-block",
      props: { title: "孤独的神经元", underline: "sweep" },
    });

    expect(shot).toMatchObject({
      shotId: "sh-001",
      visualType: "component",
      componentId: "keyword-block",
      transition: { in: "hard-cut", out: "hard-cut" },
      source: null,
      assetRefs: [],
    });
    expect(shot.animations).toEqual([
      { effect: "title-in", atMs: 0, durationMs: 400 },
      { effect: "underline-sweep", atMs: 100, durationMs: 400 },
    ]);
  });

  test("装配支持覆盖动效时长，越界或非法组件/参数抛 CONFIG_INVALID", () => {
    const shot = assembleComponentShot({
      shotId: "sh-002",
      componentId: "data-card",
      props: { label: "命中率", value: "98.7", unit: "%", trend: "up" },
      animationDurationMs: 600,
    });
    expect(shot.animations.every((animation) => animation.durationMs === 600)).toBe(true);

    expect(() =>
      assembleComponentShot({
        shotId: "sh-003",
        componentId: "data-card",
        props: { label: "命中率", value: "98.7" },
        animationDurationMs: 200,
      }),
    ).toThrowError(/300–800ms/);
    expect(() =>
      assembleComponentShot({ shotId: "sh-004", componentId: "no-such", props: {} }),
    ).toThrowError(/未知组件/);
    expect(() =>
      assembleComponentShot({ shotId: "sh-005", componentId: "quote-card", props: {} }),
    ).toThrowError(/缺少必填参数 quote/);
  });
});
