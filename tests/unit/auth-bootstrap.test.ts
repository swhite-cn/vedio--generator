import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureAdminUser } from "../../apps/server/src/auth/bootstrap";
import { hashPassword, verifyPassword } from "../../apps/server/src/auth/password";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import {
  findUserByUsername,
  updatePassword,
} from "../../apps/server/src/db/repositories/user-repository";
import type { SystemConfig } from "../../packages/pipeline/src/config";

/** 构造仅含 admin_password_env 的最小配置对象。 */
function makeConfig(envName = "VF_ADMIN_INITIAL_PASSWORD"): SystemConfig {
  return { server: { admin_password_env: envName } } as unknown as SystemConfig;
}

describe("admin 幂等初始化", () => {
  let directory: string;
  let database: ReturnType<typeof createDatabase>;
  const originalAdminPassword = process.env.VF_ADMIN_INITIAL_PASSWORD;

  beforeEach(async () => {
    // 排除开发机真实环境变量干扰：默认口令与自定义口令用例自行设置
    delete process.env.VF_ADMIN_INITIAL_PASSWORD;
    directory = await mkdtemp(join(tmpdir(), "videoforge-auth-"));
    const filename = join(directory, "videoforge.db");
    migrateDatabase(filename);
    database = createDatabase(filename);
  });

  afterEach(async () => {
    database.sqlite.close();
    await rm(directory, { recursive: true, force: true });
    if (originalAdminPassword === undefined) delete process.env.VF_ADMIN_INITIAL_PASSWORD;
    else process.env.VF_ADMIN_INITIAL_PASSWORD = originalAdminPassword;
  });

  test("全新库创建 admin（role=admin、must_change_password=1）", () => {
    const result = ensureAdminUser({ db: database.db, config: makeConfig(), rootDir: directory });
    expect(result.created).toBe(true);
    const admin = findUserByUsername(database.db, "admin");
    expect(admin).toBeDefined();
    expect(admin?.role).toBe("admin");
    expect(admin?.must_change_password).toBe(true);
    expect(admin?.password_hash).toMatch(/^scrypt\$/);
  });

  test("未设置环境变量时回退默认口令 mongoose-admin，且默认口令可登录", () => {
    ensureAdminUser({ db: database.db, config: makeConfig(), rootDir: directory });
    const admin = findUserByUsername(database.db, "admin")!;
    expect(verifyPassword("mongoose-admin", admin.password_hash)).toBe(true);
    expect(verifyPassword("wrong-password", admin.password_hash)).toBe(false);
  });

  test("环境变量指定初始口令时优先使用之", () => {
    process.env.VF_ADMIN_INITIAL_PASSWORD = "custom-init-123";
    ensureAdminUser({ db: database.db, config: makeConfig(), rootDir: directory });
    const admin = findUserByUsername(database.db, "admin")!;
    expect(verifyPassword("custom-init-123", admin.password_hash)).toBe(true);
    expect(verifyPassword("mongoose-admin", admin.password_hash)).toBe(false);
  });

  test("重复调用返回 created:false 且不覆盖已改密码（模拟重启）", () => {
    expect(
      ensureAdminUser({ db: database.db, config: makeConfig(), rootDir: directory }).created,
    ).toBe(true);
    const admin = findUserByUsername(database.db, "admin")!;

    // 模拟用户完成首改密码
    const newHash = hashPassword("brand-new-pass");
    updatePassword(database.db, { userId: admin.id, role: "admin" }, newHash, false);
    const changed = findUserByUsername(database.db, "admin")!;

    // 模拟重启：对同一 DB 再执行一次初始化
    const second = ensureAdminUser({ db: database.db, config: makeConfig(), rootDir: directory });
    expect(second.created).toBe(false);

    const after = findUserByUsername(database.db, "admin")!;
    expect(after.password_hash).toBe(changed.password_hash);
    expect(after.must_change_password).toBe(false);
    expect(verifyPassword("brand-new-pass", after.password_hash)).toBe(true);
  });
});
