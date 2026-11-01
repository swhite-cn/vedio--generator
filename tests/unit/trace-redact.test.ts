import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSensitiveValues,
  createRedactor,
  redactDeep,
  redactText,
} from "../../apps/server/src/trace/redact";

describe("trace 脱敏器", () => {
  const tempDirs: string[] = [];
  const envBackup: Record<string, string | undefined> = {};

  /** 创建临时 rootDir（可选写入 .env.local）。 */
  function makeRoot(envContent?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-redact-"));
    tempDirs.push(dir);
    if (envContent !== undefined) writeFileSync(join(dir, ".env.local"), envContent, "utf-8");
    return dir;
  }

  /** 设置环境变量并记录原值以便还原。 */
  function setEnv(key: string, value: string): void {
    if (!(key in envBackup)) envBackup[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(envBackup)) delete envBackup[key];
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("收集已知敏感值：含内置 admin 口令，去重并过滤过短值", () => {
    setEnv("ARK_API_KEY", "ark-secret-value");
    setEnv("JWT_SECRET", "jwt-secret-value");
    setEnv("VF_ADMIN_INITIAL_PASSWORD", "env-admin-pass");
    const values = collectSensitiveValues(makeRoot(), ["extra-secret", "abc", "extra-secret"]);
    expect(values).toContain("ark-secret-value");
    expect(values).toContain("jwt-secret-value");
    expect(values).toContain("env-admin-pass");
    expect(values).toContain("mongoose-admin");
    expect(values).toContain("extra-secret");
    expect(values).not.toContain("abc");
    expect(values.filter((v) => v === "extra-secret")).toHaveLength(1);
  });

  it("能从 .env.local 读取敏感值", () => {
    const root = makeRoot("ARK_API_KEY=local-ark-key\n");
    const values = collectSensitiveValues(root);
    expect(values).toContain("local-ark-key");
  });

  it("redactText 用 *** 替换已知敏感值子串", () => {
    setEnv("ARK_API_KEY", "super-secret-key");
    const values = collectSensitiveValues(makeRoot());
    expect(redactText("key=super-secret-key rest", values)).toBe("key=*** rest");
  });

  it("redactText 替换赋值与 CLI 形态的键名后值", () => {
    const out = redactText("ARK_API_KEY=xyz-unlisted JWT_SECRET: abcdef --key topsecretvalue", []);
    expect(out).not.toContain("xyz-unlisted");
    expect(out).not.toContain("abcdef");
    expect(out).not.toContain("topsecretvalue");
    expect(out).toContain("ARK_API_KEY=***");
  });

  it("redactText 不因奇怪输入抛错", () => {
    expect(() => redactText("", [])).not.toThrow();
    expect(redactText("normal text", ["", "short"])).toBe("normal text");
  });

  it("redactDeep 递归脱敏对象/数组/字符串", () => {
    setEnv("ARK_API_KEY", "deep-secret-value");
    const values = collectSensitiveValues(makeRoot());
    const redacted = redactDeep(
      { a: "deep-secret-value", b: ["x deep-secret-value", 1, true], c: { d: null } },
      values,
    );
    expect(redacted).toEqual({
      a: "***",
      b: ["x ***", 1, true],
      c: { d: null },
    });
  });

  it("redactDeep 对循环引用不进入死循环", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redactDeep(cyclic, ["secret-value"])).not.toThrow();
  });

  it("createRedactor 返回可复用闭包并缓存敏感值", () => {
    setEnv("ARK_API_KEY", "closure-secret-value");
    const redactor = createRedactor(makeRoot());
    expect(redactor("token closure-secret-value")).toBe("token ***");
    expect(redactor({ nested: ["a closure-secret-value"] })).toEqual({ nested: ["a ***"] });
  });
});
