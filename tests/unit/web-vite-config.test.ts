import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadApiProxyTarget } from "../../apps/web/vite-server-config";

let rootDir = "";

/**
 * 在临时项目根目录写入系统 YAML 配置。
 * @param name 配置文件名
 * @param content YAML 配置内容
 */
function writeConfig(name: string, content: string): void {
  writeFileSync(join(rootDir, "config", name), content, "utf8");
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "videoforge-web-config-"));
  mkdirSync(join(rootDir, "config"));
  writeConfig("default.yaml", "server:\n  port: 3000\n");
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("loadApiProxyTarget", () => {
  test("uses the default server port", () => {
    expect(loadApiProxyTarget(rootDir)).toBe("http://127.0.0.1:3000");
  });

  test("prefers the local server port", () => {
    writeConfig("system.local.yaml", "server:\n  port: 4521\n");
    expect(loadApiProxyTarget(rootDir)).toBe("http://127.0.0.1:4521");
  });

  test("rejects a port outside the valid range", () => {
    writeConfig("system.local.yaml", "server:\n  port: 70000\n");
    expect(() => loadApiProxyTarget(rootDir)).toThrow("server.port");
  });

  test("rejects an explicitly empty local port instead of falling back", () => {
    writeConfig("system.local.yaml", "server:\n  port: null\n");
    expect(() => loadApiProxyTarget(rootDir)).toThrow("server.port");
  });
});
