import { describe, expect, it } from "vitest";
import {
  assertProjectRunnable,
  isRunnableContract,
  legacyProjectMigrationHint,
} from "../../apps/server/src/domain/project-contract";
import { VideoForgeError } from "@videoforge/shared";

describe("project-contract（T504 存量项目迁移判定）", () => {
  it("仅 v2 契约可运行", () => {
    expect(isRunnableContract("2.0")).toBe(true);
    expect(isRunnableContract("1.0")).toBe(false);
    expect(isRunnableContract(null)).toBe(false);
    expect(isRunnableContract(undefined)).toBe(false);
  });

  it("迁移提示包含实际契约版本与可执行动作", () => {
    const hint = legacyProjectMigrationHint("1.0");
    expect(hint).toContain("契约版本为 1.0");
    expect(hint).toContain("无法续跑");
    expect(hint).toContain("新建项目");
    // 版本缺失时按 1.0 表述，避免出现 undefined
    expect(legacyProjectMigrationHint(null)).toContain("契约版本为 1.0");
  });

  it("非 v2 断言抛 CONFIG_INVALID 且带迁移提示", () => {
    expect(() => assertProjectRunnable("2.0")).not.toThrow();
    try {
      assertProjectRunnable("1.0");
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(VideoForgeError);
      expect((error as VideoForgeError).code).toBe("CONFIG_INVALID");
      expect((error as VideoForgeError).message).toContain("无法续跑");
    }
  });
});
