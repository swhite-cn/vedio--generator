import type { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import type { SystemConfig } from "@videoforge/pipeline";
import type { User, UserRole } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";

/**
 * JWT 签发与校验模块（见设计文档 §8.1「令牌」、§8.2「角色」）。
 * 基于 `@fastify/jwt`（HS256）。access token 载荷只放 `{ sub, username, role, iat, exp }`，
 * 角色随令牌下发以省一次查库，密钥/密码/哈希绝不入载荷。
 * 校验失败（缺失 / 过期 / 签名不符）统一映射为 `AUTH_INVALID`(401)，不向调用方泄露失败原因。
 * 刻意不引入 refresh token：本机单机部署，续期成本高于收益，过期即重新登录。
 */

/** access token 解码后的载荷结构（见设计文档 §8.1）。 */
export interface AccessTokenPayload {
  /** 用户 ID。 */
  sub: string;
  /** 归一化后的用户名。 */
  username: string;
  /** 用户角色。 */
  role: UserRole;
  /** 签发时间（由 @fastify/jwt 自动写入）。 */
  iat?: number;
  /** 过期时间（由 @fastify/jwt 依据 TTL 自动写入）。 */
  exp?: number;
}

/**
 * 注册 JWT 插件；签发有效期取 `server.access_token_ttl`。
 * @param app Fastify 实例
 * @param config 系统配置（提供 `server.access_token_ttl`）
 * @param secret 由 `loadJwtSecret` 提供的 HS256 密钥
 */
export async function registerJwt(
  app: FastifyInstance,
  config: SystemConfig,
  secret: string,
): Promise<void> {
  await app.register(fastifyJwt, {
    secret,
    sign: { expiresIn: config.server.access_token_ttl },
  });
}

/**
 * 为用户签发 access token；载荷仅含 sub/username/role（iat/exp 由插件按 TTL 补齐）。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param user 目标用户（读取 id/username/role，绝不读取密码哈希）
 * @returns 已签名的 JWT 字符串
 */
export function signAccessToken(app: FastifyInstance, user: User): string {
  return app.jwt.sign({ sub: user.id, username: user.username, role: user.role });
}

/**
 * 校验 access token 并返回载荷；任何失败（缺失 / 过期 / 签名不符 / 格式错）统一抛 AUTH_INVALID。
 * @param app 已注册 JWT 插件的 Fastify 实例
 * @param token 待校验的 JWT 字符串
 * @returns 校验通过的解码载荷
 */
export function verifyAccessToken(app: FastifyInstance, token: string): AccessTokenPayload {
  try {
    return app.jwt.verify<AccessTokenPayload>(token);
  } catch {
    throw new VideoForgeError("AUTH_INVALID", "令牌无效或已过期");
  }
}
