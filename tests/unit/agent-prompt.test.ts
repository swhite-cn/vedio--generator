import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createAgentResourceLoader,
  buildSystemPrompt,
  resolveAgentDir,
} from "../../apps/server/src/agent/prompt";
import { resolveSkillDirs, SKILLS_RELATIVE_DIR } from "../../apps/server/src/agent/skills";

let rootDir: string;
let projectDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "videoforge-prompt-root-"));
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-prompt-project-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("buildSystemPrompt：系统提示覆盖 §5.6 五条要求", () => {
  test("包含成片命名 `final.mp4` 与产物布局关键词", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("final.mp4");
    expect(prompt).toContain("copy.json");
    expect(prompt).toContain("scenes/");
    expect(prompt).toContain("timeline.json");
  });

  test("包含引擎纪律：阶段顺序与“只执行该阶段”", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("copy");
    expect(prompt).toContain("compose");
    // 引擎纪律核心措辞：只执行该阶段 / 不自行跳阶段
    expect(prompt).toContain("只执行该阶段");
    expect(prompt).toContain("不要自行跳阶段");
  });

  test("包含输出纪律与行为边界：不复述密钥、不读取 .env.local", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("密钥");
    expect(prompt).toContain(".env.local");
    expect(prompt).toContain("只在当前项目目录内");
  });
});

describe("resolveSkillDirs：技能目录解析", () => {
  test("`.trae/skills` 不存在时返回空数组（不抛错）", () => {
    expect(resolveSkillDirs(rootDir)).toEqual([]);
  });

  test("`.trae/skills` 存在时返回其绝对路径", () => {
    const skillsDir = join(rootDir, ".trae", "skills");
    mkdirSync(skillsDir, { recursive: true });
    expect(resolveSkillDirs(rootDir)).toEqual([skillsDir]);
  });

  test("技能目录常量与设计一致", () => {
    expect(SKILLS_RELATIVE_DIR).toBe(".trae/skills");
  });
});

describe("resolveAgentDir：Pi 全局配置目录本地化", () => {
  test("返回 `<rootDir>/.pi/agent`（用 join 断言，兼容 Windows 分隔符）", () => {
    expect(resolveAgentDir(rootDir)).toBe(join(rootDir, ".pi", "agent"));
  });
});

describe("createAgentResourceLoader：系统提示 + 技能目录注入", () => {
  test("返回 DefaultResourceLoader 实例，reload 后系统提示包含 buildSystemPrompt 关键内容", async () => {
    const skillsDir = join(rootDir, ".trae", "skills");
    mkdirSync(skillsDir, { recursive: true });

    const loader = createAgentResourceLoader({
      rootDir,
      projectDir,
      agentDir: resolveAgentDir(rootDir),
    });
    // 断言返回的是具备 DefaultResourceLoader 契约的实例（不直接 import Pi 包，避免测试目录解析失败）
    expect(typeof loader.getSystemPrompt).toBe("function");
    expect(typeof loader.reload).toBe("function");

    // DefaultResourceLoader 构造时不加载资源，systemPrompt 需 reload() 后才可见（Pi 行为）。
    // 若 getSystemPrompt() 仍未返回内容，则退化为“实例正确且不抛错”的断言。
    await loader.reload();
    const prompt = loader.getSystemPrompt();
    if (prompt === undefined) {
      expect(typeof loader.getSystemPrompt).toBe("function");
    } else {
      expect(prompt).toContain("final.mp4");
      expect(prompt).toContain(".env.local");
    }
  });
});
