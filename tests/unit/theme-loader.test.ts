import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  THEME_FILE_NAME,
  THEME_SNAPSHOT_FILE,
  ensureThemeSnapshot,
  loadTheme,
  readThemeSnapshot,
  resolveThemeSnapshot,
} from "../../packages/pipeline/src/index";

/** 仓库根目录（真实 config/themes 所在位置）。 */
const repoRoot = process.cwd();

let tempRoot: string;
let projectDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "videoforge-theme-"));
  projectDir = join(tempRoot, "project");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * 在临时根目录写入一个主题源文件。
 * @param themeId 目录名（也是约定主题 ID）
 * @param content YAML 原文
 */
function writeThemeFile(themeId: string, content: string): void {
  const dir = join(tempRoot, "config", "themes", themeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, THEME_FILE_NAME), content, "utf-8");
}

/** 一份结构合法的主题 YAML（id 可替换）。 */
function validThemeYaml(id: string): string {
  return [
    `id: ${id}`,
    "name: 测试主题",
    "frame:",
    "  width: 1920",
    "  height: 1080",
    "  safe_area: 0.9",
    "tokens:",
    '  text: "#E5E0D5"',
    '  background: "#111310"',
    '  accent: "#F1E21D"',
    "  secondary: []",
    '  font_family: "PingFang SC, Microsoft YaHei, system-ui"',
    "  title_size: 96",
    "  body_size: 40",
    "  caption:",
    "    size: 44",
    "    stroke: 4",
    "    bottom_ratio: 0.06",
    "    max_chars_per_line: 18",
    "motion:",
    "  min_duration_ms: 300",
    "  max_duration_ms: 800",
  ].join("\n");
}

describe("主题加载", () => {
  test("加载仓库内置 documentary-dark 主题", () => {
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    expect(theme.id).toBe("documentary-dark");
    expect(theme.name).toBe("硬核科普深色");
    expect(theme.frame).toMatchObject({ width: 1920, height: 1080, safe_area: 0.9 });
    expect(theme.tokens.accent).toBe("#F1E21D");
    expect(theme.tokens.caption.max_chars_per_line).toBe(18);
    expect(theme.motion).toMatchObject({ min_duration_ms: 300, max_duration_ms: 800 });
  });

  test("主题不存在时抛 CONFIG_INVALID", () => {
    expect(() => loadTheme({ rootDir: tempRoot, themeId: "missing" })).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("目录名与 theme.id 不一致时抛 CONFIG_INVALID", () => {
    writeThemeFile("theme-a", validThemeYaml("theme-b"));
    expect(() => loadTheme({ rootDir: tempRoot, themeId: "theme-a" })).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("非法配色抛 CONFIG_INVALID", () => {
    writeThemeFile("theme-bad-color", validThemeYaml("theme-bad-color").replace("#F1E21D", "yellow"));
    expect(() => loadTheme({ rootDir: tempRoot, themeId: "theme-bad-color" })).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("YAML 语法非法抛 CONFIG_INVALID", () => {
    writeThemeFile("theme-bad-yaml", "id: [未闭合");
    expect(() => loadTheme({ rootDir: tempRoot, themeId: "theme-bad-yaml" })).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  test("空主题 ID 抛 CONFIG_INVALID", () => {
    expect(() => loadTheme({ rootDir: tempRoot, themeId: "   " })).toThrowError(/CONFIG_INVALID/);
  });
});

describe("项目主题快照", () => {
  test("创建时写入 theme.resolved.json 并可读回", () => {
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const snapshot = ensureThemeSnapshot(projectDir, theme, "2026-11-07T00:00:00.000Z");

    expect(snapshot).toMatchObject({
      version: "1",
      themeId: "documentary-dark",
      resolvedAt: "2026-11-07T00:00:00.000Z",
    });
    expect(snapshot.theme.tokens.text).toBe("#E5E0D5");
    expect(readThemeSnapshot(projectDir)).toEqual(snapshot);

    const onDisk = JSON.parse(
      readFileSync(join(projectDir, THEME_SNAPSHOT_FILE), "utf-8"),
    ) as Record<string, unknown>;
    expect(onDisk.themeId).toBe("documentary-dark");
  });

  test("已存在时不覆盖历史快照（切换主题不改组件/视觉语言）", () => {
    const first = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    ensureThemeSnapshot(projectDir, first, "2026-11-01T00:00:00.000Z");

    writeThemeFile("theme-b", validThemeYaml("theme-b"));
    const second = loadTheme({ rootDir: tempRoot, themeId: "theme-b" });
    const kept = ensureThemeSnapshot(projectDir, second, "2026-11-07T00:00:00.000Z");

    expect(kept.themeId).toBe("documentary-dark");
    expect(kept.resolvedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(kept.theme.tokens.accent).toBe("#F1E21D");
  });

  test("快照缺失时返回 null", () => {
    expect(readThemeSnapshot(projectDir)).toBeNull();
  });

  test("快照非 JSON 时抛 ADAPTER_PROTOCOL_INVALID", () => {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, THEME_SNAPSHOT_FILE), "不是 JSON", "utf-8");
    expect(() => readThemeSnapshot(projectDir)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  test("resolveThemeSnapshot 展开完整主题且 ID 一致", () => {
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const snapshot = resolveThemeSnapshot(theme, "2026-11-07T00:00:00.000Z");
    expect(snapshot.themeId).toBe(theme.id);
    expect(snapshot.theme).toEqual(theme);
  });
});
