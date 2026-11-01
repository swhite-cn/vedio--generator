import { loadLocalEnv } from "@videoforge/pipeline";
import type { SystemConfig } from "@videoforge/pipeline";
import { VideoForgeError } from "@videoforge/shared";

/**
 * JWT 密钥加载模块（见设计文档 §8.1「密钥」）。
 * 密钥只从环境变量读取，变量名由 `server.jwt_secret_env` 指定；缺失或长度 < 32 时抛 CONFIG_INVALID。
 * 刻意不现场生成随机密钥——否则每次重启令牌全部失效，行为不可预期。
 * 本模块不得打印密钥值。
 */

/** JWT 密钥允许的最小长度（含）。 */
const MIN_SECRET_LENGTH = 32;

/**
 * 按配置读取 JWT 密钥：先加载 .env.local（不覆盖已存在的环境变量），再读指定环境变量。
 * @param config 系统配置（提供 `server.jwt_secret_env`）
 * @param rootDir 仓库根目录，用于定位 `.env.local`
 * @returns 长度 >= 32 的 JWT 密钥
 * @throws VideoForgeError(CONFIG_INVALID) 当环境变量缺失或长度不足
 */
export function loadJwtSecret(config: SystemConfig, rootDir: string): string {
  loadLocalEnv(rootDir);
  const envName = config.server.jwt_secret_env;
  const secret = process.env[envName];
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `JWT 密钥缺失或长度不足 ${MIN_SECRET_LENGTH}：请通过环境变量 ${envName} 配置`,
    );
  }
  return secret;
}
