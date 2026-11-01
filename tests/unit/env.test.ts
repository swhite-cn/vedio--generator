import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getArkApiKey, loadLocalEnv } from "../../packages/pipeline/src/env";
import { VideoForgeError } from "../../packages/shared/src/errors";

describe("环境变量加载", () => {
  const tempDirs: string[] = [];
  const originalKey = process.env.ARK_API_KEY;

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-env-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
    delete process.env.VF_TEST_KEY;
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("能从 .env.local 读取键值并注入 process.env", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".env.local"), '# 注释\nVF_TEST_KEY=hello\nQUOTED="a b"\n', "utf-8");
    loadLocalEnv(root);
    expect(process.env.VF_TEST_KEY).toBe("hello");
    expect(process.env.QUOTED).toBe("a b");
    delete process.env.QUOTED;
  });

  it("不覆盖已存在的环境变量", () => {
    const root = makeRoot();
    process.env.VF_TEST_KEY = "original";
    writeFileSync(join(root, ".env.local"), "VF_TEST_KEY=new\n", "utf-8");
    loadLocalEnv(root);
    expect(process.env.VF_TEST_KEY).toBe("original");
  });

  it(".env.local 不存在时静默跳过", () => {
    expect(() => loadLocalEnv(makeRoot())).not.toThrow();
  });

  it("getArkApiKey 在缺失时抛 CONFIG_INVALID", () => {
    delete process.env.ARK_API_KEY;
    expect(() => getArkApiKey(makeRoot())).toThrowError(VideoForgeError);
    expect(() => getArkApiKey(makeRoot())).toThrowError(/CONFIG_INVALID/);
  });

  it("getArkApiKey 优先读取 process.env", () => {
    process.env.ARK_API_KEY = "env-key";
    expect(getArkApiKey(makeRoot())).toBe("env-key");
  });
});
