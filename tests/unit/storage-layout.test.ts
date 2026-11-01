import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveUserProjectDir } from "../../apps/server/src/domain/storage-layout";

const STORAGE_ROOT = "C:\\storage\\videoforge";
const USER_ID = "11111111-2222-3333-4444-555555555555";

describe("storage-layout.resolveUserProjectDir（§8.3 目录布局）", () => {
  test("普通名称落盘到 users/<userId>/projects/<name>", () => {
    expect(resolveUserProjectDir(STORAGE_ROOT, USER_ID, "demo")).toBe(
      resolve(STORAGE_ROOT, "users", USER_ID, "projects", "demo"),
    );
  });

  test("中文项目名可用", () => {
    expect(resolveUserProjectDir(STORAGE_ROOT, USER_ID, "黑洞科普")).toBe(
      resolve(STORAGE_ROOT, "users", USER_ID, "projects", "黑洞科普"),
    );
  });

  test("含空格的项目名可用", () => {
    expect(resolveUserProjectDir(STORAGE_ROOT, USER_ID, "my video project")).toBe(
      resolve(STORAGE_ROOT, "users", USER_ID, "projects", "my video project"),
    );
  });

  test("正斜杠 storageRoot 归一化为系统分隔符", () => {
    const expected = resolve("C:/storage/videoforge", "users", USER_ID, "projects", "demo");
    expect(resolveUserProjectDir("C:/storage/videoforge", USER_ID, "demo")).toBe(expected);
  });

  test("首尾空白与末尾点被归一化去除", () => {
    expect(resolveUserProjectDir(STORAGE_ROOT, USER_ID, "  项目.  ")).toBe(
      resolve(STORAGE_ROOT, "users", USER_ID, "projects", "项目"),
    );
  });

  test("非法名（含路径分隔符）抛 PATH_OUTSIDE_STORAGE", () => {
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "a/b")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "a\\b")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
  });

  test("目录逃逸名（..）抛 PATH_OUTSIDE_STORAGE", () => {
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "..")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "../evil")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
  });

  test("Windows 保留字符抛 PATH_OUTSIDE_STORAGE", () => {
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "a:b")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "a*b?c")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
  });

  test("空名与超长名抛 PATH_OUTSIDE_STORAGE", () => {
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "   ")).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
    expect(() => resolveUserProjectDir(STORAGE_ROOT, USER_ID, "x".repeat(65))).toThrow(
      "PATH_OUTSIDE_STORAGE",
    );
  });
});
