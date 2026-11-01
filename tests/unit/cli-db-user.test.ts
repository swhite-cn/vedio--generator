import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";
import { findUserByUsername } from "../../apps/server/src/db/repositories/user-repository";
import { createUser } from "../../apps/server/src/db/repositories/user-repository";
import { verifyPassword } from "../../apps/server/src/auth/password";
import { generateRandomPassword, runDbUser } from "../../apps/cli/src/db-user";

/** 临时目录与数据库连接（每个用例独立）。 */
let directory: string;
let database: ReturnType<typeof createDatabase>;
/** stdout 捕获的原始写入片段。 */
let written: string[];
/** stdout.write 的 spy，afterEach 恢复。 */
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** base64url 字符集校验。 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * 从捕获的 stdout 片段中取出第一行机器可读 JSON 并解析。
 * @returns 解析后的对象
 */
function parseJsonLine(): any {
  const line = written.find((chunk) => chunk.trim().startsWith("{"));
  if (!line) throw new Error("stdout 未出现 JSON 行");
  return JSON.parse(line.trim());
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vf-db-user-"));
  const filename = join(directory, "videoforge.db");
  migrateDatabase(filename);
  database = createDatabase(filename);
  written = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("db:user（§3.5/§8.1 运维建号与救援）", () => {
  it("列出用户：输出不含 password_hash", async () => {
    createUser(database.db, {
      username: "admin",
      passwordHash: "scrypt$h",
      displayName: "Admin",
      role: "admin",
    });
    createUser(database.db, { username: "alice", passwordHash: "scrypt$h", displayName: "Alice" });

    await runDbUser(process.cwd(), {}, { db: database.db });

    const parsed = parseJsonLine();
    expect(parsed.users).toHaveLength(2);
    expect(parsed.users.map((row: any) => row.username).sort()).toEqual(["admin", "alice"]);
    expect(JSON.stringify(parsed)).not.toContain("password_hash");
  });

  it("--create alice 返回一次性口令并置 must_change_password=1", async () => {
    await runDbUser(process.cwd(), { create: "alice" }, { db: database.db });

    const parsed = parseJsonLine();
    expect(parsed.created).toBe(true);
    expect(parsed.username).toBe("alice");
    expect(parsed.role).toBe("user");
    expect(parsed.password.length).toBeGreaterThanOrEqual(8);

    const user = findUserByUsername(database.db, "alice");
    expect(user?.must_change_password).toBe(true);
    // 明文口令仅输出一次，不入库；库中存的是可校验的哈希
    expect(user?.password_hash).not.toBe(parsed.password);
    expect(verifyPassword(parsed.password, user!.password_hash)).toBe(true);
  });

  it("--create --role admin 可创建额外管理员", async () => {
    await runDbUser(process.cwd(), { create: "ops", role: "admin" }, { db: database.db });
    const parsed = parseJsonLine();
    expect(parsed.role).toBe("admin");
    expect(findUserByUsername(database.db, "ops")?.role).toBe("admin");
  });

  it("--create admin 抛 AUTH_FORBIDDEN（保留用户名）", async () => {
    await expect(
      runDbUser(process.cwd(), { create: "admin" }, { db: database.db }),
    ).rejects.toThrow(/AUTH_FORBIDDEN/);
  });

  it("--reset-password 重置口令并置 must_change_password=1", async () => {
    createUser(database.db, {
      username: "bob",
      passwordHash: "scrypt$old",
      displayName: "Bob",
      mustChangePassword: false,
    });

    await runDbUser(process.cwd(), { "reset-password": "bob" }, { db: database.db });

    const parsed = parseJsonLine();
    expect(parsed.reset).toBe(true);
    expect(parsed.username).toBe("bob");
    const user = findUserByUsername(database.db, "bob");
    expect(user?.must_change_password).toBe(true);
    expect(verifyPassword(parsed.password, user!.password_hash)).toBe(true);
  });

  it("--reset-password 目标不存在时抛 CONFIG_INVALID", async () => {
    await expect(
      runDbUser(process.cwd(), { "reset-password": "nobody" }, { db: database.db }),
    ).rejects.toThrow(/CONFIG_INVALID/);
  });

  it("--create 与 --reset-password 互斥", async () => {
    await expect(
      runDbUser(process.cwd(), { create: "a", "reset-password": "b" }, { db: database.db }),
    ).rejects.toThrow(/CONFIG_INVALID/);
  });
});

describe("generateRandomPassword", () => {
  it("默认长度落在 8..128 且字符集为 base64url", () => {
    const password = generateRandomPassword();
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password.length).toBeLessThanOrEqual(128);
    expect(BASE64URL.test(password)).toBe(true);
  });

  it("对过小 byteLength 做下界保护（长度仍 >= 8）", () => {
    const password = generateRandomPassword(1);
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(BASE64URL.test(password)).toBe(true);
  });

  it("对过大 byteLength 做上界保护（长度仍 <= 128）", () => {
    const password = generateRandomPassword(10_000);
    expect(password.length).toBeLessThanOrEqual(128);
    expect(BASE64URL.test(password)).toBe(true);
  });
});
