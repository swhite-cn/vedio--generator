import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptSet, renderTemplate } from "../../packages/pipeline/src/prompts";

/** 在临时根目录写入指定提示词集的部分/全部模板文件 */
function writePromptFiles(root: string, setName: string, files: Record<string, string>): void {
  const dir = join(root, "config", "prompts", setName);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
}

describe("提示词集加载与模板替换", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** 创建临时根目录并登记清理 */
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vf-prompts-"));
    dirs.push(root);
    return root;
  }

  it("无 config/prompts 目录时回退内置默认提示词", () => {
    const set = loadPromptSet({ rootDir: makeRoot() });
    expect(set.name).toBe("default");
    expect(set.source).toBe("builtin");
    expect(set.copySystem).toContain("短视频编剧");
    expect(set.imageSuffix).toContain("不要出现任何文字");
    expect(set.sceneSystem).toContain("动画工程师");
  });

  it("模板文件覆盖对应提示词，缺失文件单独回退内置", () => {
    const root = makeRoot();
    writePromptFiles(root, "default", { "copy-system.txt": "自定义文案提示词 {style}" });
    const set = loadPromptSet({ rootDir: root });
    expect(set.source).toBe("file");
    expect(set.copySystem).toBe("自定义文案提示词 {style}");
    // 未提供的文件回退内置
    expect(set.imageSuffix).toContain("不要出现任何文字");
    expect(set.sceneSystem).toContain("动画工程师");
  });

  it("加载自定义集目录（如按内容风格区分的集）", () => {
    const root = makeRoot();
    writePromptFiles(root, "历史", {
      "copy-system.txt": "历史风格文案提示词",
      "scene-system.txt": "历史风格场景提示词",
    });
    const set = loadPromptSet({ rootDir: root, setName: "历史" });
    expect(set.name).toBe("历史");
    expect(set.source).toBe("file");
    expect(set.copySystem).toBe("历史风格文案提示词");
    expect(set.sceneSystem).toBe("历史风格场景提示词");
  });

  it("显式指定不存在的集时报 CONFIG_INVALID，防止笔误静默落到默认", () => {
    expect(() => loadPromptSet({ rootDir: makeRoot(), setName: "不存在集" })).toThrowError(
      /CONFIG_INVALID/,
    );
  });

  it("显式指定 default 但目录缺失时仍回退内置（兼容无文件环境）", () => {
    const set = loadPromptSet({ rootDir: makeRoot(), setName: "default" });
    expect(set.source).toBe("builtin");
  });

  it("renderTemplate 只替换已知变量，保留 JSON 花括号等其他内容", () => {
    const tpl = '{"html":"x"}\n画幅 {width}x{height}，风格 {style}，未知 {other} 保留';
    const out = renderTemplate(tpl, { width: 1920, height: 1080, style: "科普" });
    expect(out).toBe('{"html":"x"}\n画幅 1920x1080，风格 科普，未知 {other} 保留');
  });
});
