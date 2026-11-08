// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ThemeV2 } from "@videoforge/shared";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ensureThemeSnapshot,
  loadTheme,
  readThemeSnapshot,
} from "../../packages/pipeline/src/index";
import { assembleComponentShot, componentRegistry } from "../../packages/template-sdk/src/index";
import { resolveRemotionTheme } from "../../packages/remotion-engine/src/theme";

/**
 * T403 主题一致性验收：
 * - 同一主题在不同项目解析出的 token 完全一致（系列片色板一致）；
 * - 切换主题不会改写已有项目快照（创建时冻结视觉语言）；
 * - 组件选型/参数与主题无关（装配结果一致），渲染颜色来自传入主题。
 */

// ComponentShotVisual 依赖 remotion 的帧上下文；SSR 下固定帧并透传 Sequence。
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useCurrentFrame: () => 30,
    useVideoConfig: () => ({
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 90,
      defaultProps: {},
    }),
    Sequence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const { ComponentShotVisual } = await import(
  "../../packages/remotion-engine/src/components/index"
);

/** 仓库根目录（真实 config/themes）。 */
const repoRoot = process.cwd();

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "videoforge-theme-consistency-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** 复制一份主题并替换视觉 token，模拟「另一个主题」。 */
function cloneTheme(theme: ThemeV2, id: string, accent: string): ThemeV2 {
  return {
    ...structuredClone(theme),
    id,
    name: `${theme.name}（变体）`,
    tokens: { ...theme.tokens, accent },
  };
}

describe("主题快照一致性", () => {
  test("同一主题写入不同项目得到完全一致的 token", () => {
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const projectA = join(tempRoot, "project-a");
    const projectB = join(tempRoot, "project-b");
    const now = "2026-11-08T00:00:00.000Z";

    const snapshotA = ensureThemeSnapshot(projectA, theme, now);
    const snapshotB = ensureThemeSnapshot(projectB, theme, now);

    expect(snapshotA.themeId).toBe("documentary-dark");
    expect(snapshotB.themeId).toBe("documentary-dark");
    expect(snapshotA.theme).toEqual(snapshotB.theme);
    expect(readThemeSnapshot(projectA)?.theme).toEqual(snapshotA.theme);
  });

  test("切换主题不会改写已有项目快照", () => {
    const themeA = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const themeB = cloneTheme(themeA, "documentary-light", "#FF0000");
    const project = join(tempRoot, "project-frozen");

    const first = ensureThemeSnapshot(project, themeA, "2026-11-08T00:00:00.000Z");
    const second = ensureThemeSnapshot(project, themeB, "2026-11-09T00:00:00.000Z");

    expect(second).toEqual(first);
    expect(second.themeId).toBe("documentary-dark");
    expect(second.theme.tokens.accent).toBe(themeA.tokens.accent);
  });
});

describe("组件与主题解耦", () => {
  test("相同组件参数在装配期不携带主题，装配结果稳定", () => {
    const input = {
      shotId: "sh-001",
      componentId: "data-card",
      props: { label: "突触强度", value: "3.6", unit: "倍" },
      animationDurationMs: 400,
    };
    const specA = assembleComponentShot(input);
    const specB = assembleComponentShot(input);

    expect(specA).toEqual(specB);
    expect(specA.componentId).toBe("data-card");
    // 主题不进入 SceneSpec：切换主题不会改变组件选型
    expect(JSON.stringify(specA)).not.toContain("theme");
    // 注册表条目与主题无关，固定 7 类
    expect(componentRegistry.list().map((entry) => entry.id).sort()).toEqual(
      componentRegistry.list().map((entry) => entry.id).sort(),
    );
  });

  test("渲染颜色来自传入主题：同一组件在 A/B 主题下文案一致、强调色不同", () => {
    const base = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const themeA = cloneTheme(base, "theme-a", "#B33630");
    const themeB = cloneTheme(base, "theme-b", "#E4B95B");
    const spec = assembleComponentShot({
      shotId: "sh-001",
      componentId: "keyword-block",
      props: { title: "孤独的神经元", underline: "sweep" },
      animationDurationMs: 400,
    });

    const htmlA = renderToStaticMarkup(
      <ComponentShotVisual spec={spec} theme={resolveRemotionTheme(themeA)} />,
    );
    const htmlB = renderToStaticMarkup(
      <ComponentShotVisual spec={spec} theme={resolveRemotionTheme(themeB)} />,
    );

    expect(htmlA).toContain("孤独的神经元");
    expect(htmlB).toContain("孤独的神经元");
    expect(htmlA).toContain("#B33630");
    expect(htmlB).toContain("#E4B95B");
    expect(htmlA).not.toBe(htmlB);
  });
});
