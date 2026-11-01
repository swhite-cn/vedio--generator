import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import {
  adminListUsers,
  createUser,
  findUserById,
  findUserByUsername,
  normalizeUsername,
  updatePassword,
} from "../../apps/server/src/db/repositories/user-repository";

let directory: string;
let database: ReturnType<typeof createDatabase>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-users-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

describe("用户仓储", () => {
  test("用户名归一化为小写（大小写不敏感方案：写入前统一 toLowerCase）", () => {
    const user = createUser(database.db, {
      username: "  Alice ",
      passwordHash: "scrypt$h",
      displayName: "Alice",
    });
    expect(user.username).toBe("alice");
    expect(normalizeUsername("  ALICE ")).toBe("alice");
    // 大小写不同的输入按同一用户命中
    expect(findUserByUsername(database.db, "ALICE")?.id).toBe(user.id);
    expect(findUserById(database.db, user.id)?.username).toBe("alice");
  });

  test("角色默认 user 且 must_change_password 默认 false", () => {
    const user = createUser(database.db, {
      username: "bob",
      passwordHash: "scrypt$h",
      displayName: "Bob",
    });
    expect(user.role).toBe("user");
    expect(user.must_change_password).toBe(false);
    expect(user.last_login_at).toBeNull();
  });

  test("重复用户名（大小写不敏感）触发唯一约束", () => {
    createUser(database.db, { username: "carol", passwordHash: "scrypt$h", displayName: "Carol" });
    expect(() =>
      createUser(database.db, {
        username: "CAROL",
        passwordHash: "scrypt$h2",
        displayName: "Carol2",
      }),
    ).toThrow(/UNIQUE/i);
  });

  test("updatePassword 只改自身密码并清除 must_change_password", () => {
    const user = createUser(database.db, {
      username: "dave",
      passwordHash: "scrypt$old",
      displayName: "Dave",
      mustChangePassword: true,
    });
    updatePassword(database.db, { userId: user.id, role: "user" }, "scrypt$new", false);
    const reloaded = findUserById(database.db, user.id);
    expect(reloaded?.password_hash).toBe("scrypt$new");
    expect(reloaded?.must_change_password).toBe(false);
  });

  test("adminListUsers 仅 admin 可用，普通用户被拒", () => {
    const admin = createUser(database.db, {
      username: "admin",
      passwordHash: "scrypt$h",
      displayName: "Admin",
      role: "admin",
    });
    createUser(database.db, { username: "erin", passwordHash: "scrypt$h", displayName: "Erin" });

    const all = adminListUsers(database.db, { userId: admin.id, role: "admin" });
    expect(all.map((row) => row.username).sort()).toEqual(["admin", "erin"]);
    expect(() => adminListUsers(database.db, { userId: "x", role: "user" })).toThrow(
      "AUTH_FORBIDDEN",
    );
  });
});
