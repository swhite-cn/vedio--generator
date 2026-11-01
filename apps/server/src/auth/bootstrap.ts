import { loadLocalEnv } from "@videoforge/pipeline";
import type { SystemConfig } from "@videoforge/pipeline";
import { createUser, findUserByUsername } from "../db/repositories/user-repository.js";
import { hashPassword } from "./password.js";

/**
 * 内置管理员账号初始化模块（见设计文档 §8.1「内置管理员账号」）。
 * 幂等：仅当 users 表不存在 username='admin'（lower-case）时创建该账号（role='admin'、must_change_password=1）；
 * 已存在则原样跳过——不重置密码、不改写任何字段，避免重启把用户已改的密码冲掉。
 * 初始密码取自 `server.admin_password_env` 指定的环境变量，未设置时回退内置默认口令；
 * 该变量仅在首次创建时读取一次，明文只存在于环境变量与代码常量中，不得进入 YAML/日志/trace/返回值/测试快照。
 */

/** 内置管理员用户名（归一化后存储与比较）。 */
const ADMIN_USERNAME = "admin";
/** admin 账号展示名。 */
const ADMIN_DISPLAY_NAME = "Administrator";
/** 未配置 admin_password_env 时回退的内置默认口令（弱口令，风险与缓解见设计文档 §14.7）。 */
const DEFAULT_ADMIN_PASSWORD = "mongoose-admin";

/**
 * 解析首次创建 admin 时的初始明文口令：先加载 .env.local，再读指定环境变量，缺失或为空时回退内置默认值。
 * 仅在确认需要新建 admin 时调用，保证「只读一次」。
 * @param config 系统配置（提供 `server.admin_password_env`）
 * @param rootDir 仓库根目录，用于定位 `.env.local`
 * @returns 初始明文密码
 */
function resolveInitialAdminPassword(config: SystemConfig, rootDir: string): string {
  loadLocalEnv(rootDir);
  const fromEnv = process.env[config.server.admin_password_env];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_ADMIN_PASSWORD;
}

/**
 * 幂等地确保内置 admin 账号存在。
 * @param options.db Drizzle 数据库实例
 * @param options.config 系统配置（提供 `server.admin_password_env`）
 * @param options.rootDir 仓库根目录，用于定位 `.env.local`
 * @returns `created` 为 true 表示本次新建了 admin，false 表示已存在并原样跳过
 */
export function ensureAdminUser(options: { db: any; config: SystemConfig; rootDir: string }): {
  created: boolean;
} {
  const { db, config, rootDir } = options;
  const existing = findUserByUsername(db, ADMIN_USERNAME);
  if (existing) {
    // 已存在即原样跳过：此处不得读取初始密码环境变量，也不得改动任何字段
    console.info("[auth] admin 账号已存在，跳过初始化");
    return { created: false };
  }
  const passwordHash = hashPassword(resolveInitialAdminPassword(config, rootDir));
  createUser(db, {
    username: ADMIN_USERNAME,
    passwordHash,
    displayName: ADMIN_DISPLAY_NAME,
    role: "admin",
    mustChangePassword: true,
  });
  console.info("[auth] 已创建 admin 账号");
  return { created: true };
}
