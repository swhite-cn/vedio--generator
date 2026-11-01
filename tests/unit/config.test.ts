import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it, test } from "vitest";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/**
 * 生成满足当前 schema 的最小 default.yaml 文本。
 * 测试统一写入临时 rootDir，避免读取本机 gitignored 的 config/system.local.yaml，
 * 使断言与开发机环境无关。
 */
function minimalDefaultYaml(): string {
  return [
    "server:",
    "  port: 3000",
    '  jwt_secret_env: "JWT_SECRET"',
    '  access_token_ttl: "12h"',
    "  allow_registration: true",
    '  admin_password_env: "VF_ADMIN_INITIAL_PASSWORD"',
    "  max_projects_per_user: 50",
    "runtime:",
    '  storage_root: "storage"',
    "  max_concurrent_stage: 1",
    "  minimum_free_disk_gb: 30",
    "tools:",
    '  chromium_path: ""',
    '  ffmpeg_path: "ffmpeg"',
    '  ffprobe_path: "ffprobe"',
    "agent:",
    "  allow_shell_write_edit: true",
    "workflow:",
    "  max_stage_retry: 2",
    "engines:",
    "  endpoints:",
    "    ark:",
    '      base_url: "https://ark.example/api/plan/v3"',
    '      chat_model: "test-chat-model"',
    '      image_model: "test-image-model"',
    '      tts_speaker: "test-speaker"',
    '      tts_base_url: "https://openspeech.example/api/v3/plan/tts/unidirectional"',
    '      tts_resource_id: "seed-tts-2.0"',
    "",
  ].join("\n");
}

describe("系统配置加载", () => {
  const dirs: string[] = [];

  /** 创建带最小 config/default.yaml 的临时根目录并登记清理 */
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vf-config-"));
    dirs.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config/default.yaml"), minimalDefaultYaml(), "utf-8");
    return root;
  }

  /** 在临时根目录写入 config/system.local.yaml 覆盖内容 */
  function writeLocal(root: string, yaml: string): void {
    writeFileSync(join(root, "config/system.local.yaml"), yaml, "utf-8");
  }

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("默认配置加载成功并转换为绝对存储路径", () => {
    const config = loadSystemConfig({ rootDir: makeRoot() });
    expect(config.server.port).toBe(3000);
    // 新增服务端字段（主文档 §12.1）
    expect(config.server.jwt_secret_env).toBe("JWT_SECRET");
    expect(config.server.access_token_ttl).toBe("12h");
    expect(config.server.allow_registration).toBe(true);
    expect(config.server.admin_password_env).toBe("VF_ADMIN_INITIAL_PASSWORD");
    expect(config.server.max_projects_per_user).toBe(50);
    // 新增运行时 / agent / workflow 字段
    expect(config.runtime.max_concurrent_stage).toBe(1);
    expect(config.agent.allow_shell_write_edit).toBe(true);
    expect(config.workflow.max_stage_retry).toBe(2);
    expect(config.runtime.storage_root).toMatch(/[\\/]/);
    expect(config.runtime.storage_root).toContain("storage");
  });

  test("本机配置覆盖默认值且转换为绝对存储路径", () => {
    const root = makeRoot();
    writeLocal(
      root,
      ["server:", "  port: 4317", "runtime:", '  storage_root: "custom-storage"', ""].join("\n"),
    );
    const config = loadSystemConfig({ rootDir: root });
    expect(config.server.port).toBe(4317);
    expect(config.runtime.storage_root).toContain("custom-storage");
    expect(config.runtime.storage_root).toMatch(/[\\/]/);
  });

  test("服务端口可由覆盖项设置且必须在有效范围内", () => {
    const root = makeRoot();
    expect(
      loadSystemConfig({ rootDir: root, override: { server: { port: 4521 } } }).server.port,
    ).toBe(4521);
    expect(() =>
      loadSystemConfig({ rootDir: root, override: { server: { port: 70000 } } }),
    ).toThrow();
  });

  it("合法访问令牌有效期可通过，非法格式报 CONFIG_INVALID", () => {
    const root = makeRoot();
    for (const ttl of ["12h", "30m", "45s"]) {
      expect(
        loadSystemConfig({ rootDir: root, override: { server: { access_token_ttl: ttl } } }).server
          .access_token_ttl,
      ).toBe(ttl);
    }
    for (const ttl of ["12", "h", "12d", "-1h"]) {
      expect(() =>
        loadSystemConfig({ rootDir: root, override: { server: { access_token_ttl: ttl } } }),
      ).toThrowError(/CONFIG_INVALID/);
    }
  });

  it("新增数值字段的边界会被校验拒绝", () => {
    const root = makeRoot();
    for (const value of [0, 1001]) {
      expect(() =>
        loadSystemConfig({ rootDir: root, override: { server: { max_projects_per_user: value } } }),
      ).toThrowError(/CONFIG_INVALID/);
    }
    expect(() =>
      loadSystemConfig({ rootDir: root, override: { workflow: { max_stage_retry: 6 } } }),
    ).toThrowError(/CONFIG_INVALID/);
    expect(() =>
      loadSystemConfig({ rootDir: root, override: { runtime: { max_concurrent_stage: 0 } } }),
    ).toThrowError(/CONFIG_INVALID/);
  });

  it("ark 段的非法 base_url 会被校验拒绝", () => {
    expect(() =>
      loadSystemConfig({
        rootDir: makeRoot(),
        override: { engines: { endpoints: { ark: { base_url: "not-a-url" } } } },
      }),
    ).toThrowError(/CONFIG_INVALID/);
  });

  it("仓库默认配置保留占位模型且已移除废弃字段", () => {
    // 直接解析仓库 config/default.yaml，不经过 system.local.yaml，避免与开发机覆盖值耦合
    const doc = parse(readFileSync(resolve(process.cwd(), "config/default.yaml"), "utf-8"));
    expect(doc.engines.endpoints.ark.base_url).toContain("/api/plan/v3");
    expect(doc.engines.endpoints.ark.chat_model).toBe("PLEASE_FILL_CHAT_MODEL_ID");
    // §12.2 删除项不再出现在默认配置中
    expect(doc.runtime.worker_concurrency).toBeUndefined();
    expect(doc.python).toBeUndefined();
    expect(doc.retention).toBeUndefined();
    expect(doc.engines.tts_default).toBeUndefined();
    expect(doc.engines.tts_voice_default).toBeUndefined();
    expect(doc.engines.t2i_default).toBeUndefined();
  });
});
