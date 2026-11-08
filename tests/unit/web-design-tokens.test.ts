import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VF_THEME } from "../../apps/web/src/styles/theme";

/** 设计令牌文件路径。 */
const TOKENS_PATH = join(__dirname, "..", "..", "apps", "web", "src", "styles", "tokens.css");
/** AntD 主题映射文件路径。 */
const THEME_PATH = join(__dirname, "..", "..", "apps", "web", "src", "styles", "theme.ts");

/** 读取文本文件。 */
function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("Web 设计令牌", () => {
  const tokens = read(TOKENS_PATH);
  const theme = read(THEME_PATH);

  it("SKILL §1.1 的界面令牌全部存在", () => {
    const required = [
      "--bg",
      "--deep",
      "--surface",
      "--surface-2",
      "--inset",
      "--border",
      "--border-soft",
      "--text",
      "--text-sec",
      "--text-ter",
      "--accent",
      "--accent-soft",
      "--success",
      "--success-soft",
      "--danger",
      "--danger-soft",
      "--warning",
      "--warning-soft",
      "--info",
      "--info-soft",
      "--teal",
      "--teal-soft",
    ];
    for (const token of required) {
      expect(tokens).toMatch(new RegExp(`${token}:\\s*#[0-9A-Fa-f]{6}`));
    }
  });

  it("禁止 rgba 叠色、渐变与彩色投影", () => {
    expect(tokens).not.toMatch(/rgba\(/i);
    expect(tokens).not.toMatch(/linear-gradient|radial-gradient/i);
    expect(tokens).not.toMatch(/box-shadow:[^;]*#[0-9A-Fa-f]{3,6}\s*(?:rgb|hsl)/i);
  });

  it("成片主题色以 --film- 前缀隔离", () => {
    expect(tokens).toContain("--film-text: #e5e0d5");
    expect(tokens).toContain("--film-bg: #111310");
    expect(tokens).toContain("--film-accent: #f1e21d");
  });

  it("壳尺寸与 1440×900 设计稿一致", () => {
    expect(tokens).toContain("--shell-sider-width: 196px");
    expect(tokens).toContain("--shell-header-height: 56px");
    expect(tokens).toContain("--shell-content-padding: 28px");
    expect(tokens).toContain("--shell-inspector-width: 292px");
  });

  it("AntD 映射使用深色算法与主色 #7B6CFF", () => {
    expect(theme).toContain("antdTheme.darkAlgorithm");
    expect(theme).toContain('colorPrimary: "#7B6CFF"');
    expect(theme).toContain('colorBgBase: "#0B0E13"');
    expect(theme).toContain('colorBgContainer: "#141821"');
    expect(VF_THEME.token?.colorPrimary).toBe("#7B6CFF");
    expect(VF_THEME.components?.Card).toBeDefined();
  });
});
