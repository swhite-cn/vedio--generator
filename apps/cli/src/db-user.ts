import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import { loadSystemConfig } from "@videoforge/pipeline";
import { hashPassword } from "@videoforge/server/src/auth/password.js";
import { createDatabase } from "@videoforge/server/src/db/index.js";
import {
  adminListUsers,
  adminResetPassword,
  createUser,
  findUserByUsername,
} from "@videoforge/server/src/db/repositories/user-repository.js";

/**
 * CLI 本机运维通道固定使用的 admin 主体。
 * 仓储的 `admin*` 方法只校验 `role === 'admin'`（既有约定，见设计文档 §8.2/§8.3），
 * 本机 CLI 无 HTTP 鉴权上下文，故以固定字符串作为 userId。
 */
const CLI_ADMIN_ACTOR: Actor = { userId: "cli", role: "admin" };

/** base64url 每 3 字节编码为 4 个字符，故取字节下界 6 可保证口令长度 >= 8。 */
const MIN_PASSWORD_BYTES = 6;

/** 取字节上界 96 可保证口令长度 <= 128，满足密码策略（8..128，见设计文档 §8.1）。 */
const MAX_PASSWORD_BYTES = 96;

/**
 * 生成本机救援用随机口令（base64url）。
 * 默认 18 字节 → 24 字符；对字节数做上下界保护，确保结果长度落在 8..128 内。
 * @param byteLength 随机字节数（默认 18）
 * @returns base64url 编码的随机口令
 */
export function generateRandomPassword(byteLength = 18): string {
  const safeBytes = Math.min(MAX_PASSWORD_BYTES, Math.max(MIN_PASSWORD_BYTES, byteLength));
  return randomBytes(safeBytes).toString("base64url");
}

/**
 * `db:user`：列出用户 / `--create <username>` / `--reset-password <username>`；stdout 输出一行 JSON。
 * `--create` 与 `--reset-password` 互斥。新口令仅在本命令 stdout 一次性输出，**不写库明文**。
 * @param rootDir 仓库根目录
 * @param flags 解析后的标志表：`create` / `reset-password` / `role`
 * @param deps 可注入依赖；`deps.db` 提供时使用该连接且不关闭（测试用），否则自建连接并在结束时关闭
 * @throws VideoForgeError(`CONFIG_INVALID`) 参数互斥、库未初始化、用户名已占用、角色非法、用户不存在
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 尝试创建保留用户名 `admin`
 */
export async function runDbUser(
  rootDir: string,
  flags: Record<string, string>,
  deps: { db?: any } = {},
): Promise<void> {
  const hasCreate = flags.create !== undefined;
  const hasReset = flags["reset-password"] !== undefined;
  if (hasCreate && hasReset) {
    throw new VideoForgeError("CONFIG_INVALID", "--create 与 --reset-password 互斥");
  }

  let db = deps.db;
  let sqlite: { close: () => void } | undefined;
  if (!db) {
    const config = loadSystemConfig({ rootDir });
    const dbPath = resolve(config.runtime.storage_root, "videoforge.db");
    if (!existsSync(dbPath)) {
      throw new VideoForgeError("CONFIG_INVALID", "数据库尚未初始化，请先执行 db:migrate");
    }
    const connection = createDatabase(dbPath);
    db = connection.db;
    sqlite = connection.sqlite;
  }

  try {
    if (hasCreate) {
      handleCreate(db, flags);
      return;
    }
    if (hasReset) {
      handleReset(db, flags);
      return;
    }
    handleList(db);
  } finally {
    // 仅自建连接需要关闭；注入连接由调用方负责
    sqlite?.close();
  }
}

/**
 * 列出全部用户（不含密码哈希），stdout 输出一行 JSON。
 * @param db Drizzle 数据库实例
 */
function handleList(db: any): void {
  const users = adminListUsers(db, CLI_ADMIN_ACTOR).map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.must_change_password,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  }));
  console.info(`[cli] db:user listed ${users.length} user(s)`);
  process.stdout.write(`${JSON.stringify({ users })}\n`);
}

/**
 * `--create <username>`：创建账号（注册关闭时的建号通道），生成随机口令并置 `must_change_password=1`。
 * @param db Drizzle 数据库实例
 * @param flags 解析后的标志表：`create` / `role`
 * @throws VideoForgeError 用户名空/保留名/已占用/角色非法
 */
function handleCreate(db: any, flags: Record<string, string>): void {
  const username = flags.create.trim();
  if (!username) {
    throw new VideoForgeError("CONFIG_INVALID", "--create 需要非空用户名");
  }
  if (username.toLowerCase() === "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "admin 为保留用户名");
  }
  if (findUserByUsername(db, username)) {
    throw new VideoForgeError("CONFIG_INVALID", "用户名已占用");
  }
  const role = flags.role?.trim() || "user";
  if (role !== "admin" && role !== "user") {
    throw new VideoForgeError("CONFIG_INVALID", `--role 仅支持 admin 或 user，收到：${role}`);
  }
  const password = generateRandomPassword();
  const user = createUser(db, {
    username,
    passwordHash: hashPassword(password),
    displayName: username,
    role,
    mustChangePassword: true,
  });
  console.info(`[cli] db:user created: ${user.username} (${user.role})`);
  // 新口令按设计一次性输出到 stdout，仅此一次；不写库明文
  process.stdout.write(
    `${JSON.stringify({ created: true, username: user.username, role: user.role, password })}\n`,
  );
}

/**
 * `--reset-password <username>`：本机救援通道，重置为随机口令并置 `must_change_password=1`。
 * @param db Drizzle 数据库实例
 * @param flags 解析后的标志表：`reset-password`
 * @throws VideoForgeError(`CONFIG_INVALID`) 用户不存在
 */
function handleReset(db: any, flags: Record<string, string>): void {
  const username = flags["reset-password"].trim();
  if (!username) {
    throw new VideoForgeError("CONFIG_INVALID", "--reset-password 需要非空用户名");
  }
  const user = findUserByUsername(db, username);
  if (!user) {
    throw new VideoForgeError("CONFIG_INVALID", "用户不存在");
  }
  const password = generateRandomPassword();
  adminResetPassword(db, CLI_ADMIN_ACTOR, user.id, hashPassword(password));
  console.info(`[cli] db:user reset password for: ${user.username}`);
  // 新口令按设计一次性输出到 stdout；不写库明文
  process.stdout.write(`${JSON.stringify({ reset: true, username: user.username, password })}\n`);
}
