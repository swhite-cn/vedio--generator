// 测试文件位于仓库根 tests/，根 node_modules 在 pnpm 严格隔离下不暴露 fastify；
// 走 server 工作区本地实例解析（与 apps/server/src 内部 import 'fastify' 指向同一实例）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../apps/server/node_modules/fastify/fastify.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerJwt, signAccessToken, verifyAccessToken } from "../../apps/server/src/auth/jwt";
import { loadJwtSecret } from "../../apps/server/src/auth/secret";
import type { SystemConfig } from "../../packages/pipeline/src/config";
import type { User } from "../../packages/shared/src/domain";
import { VideoForgeError } from "../../packages/shared/src/errors";

/** 测试用假密钥（32 个 a），不得使用真实密钥。 */
const SECRET = "a".repeat(32);

/** 构造仅含 access_token_ttl 与 jwt_secret_env 的最小配置对象。 */
function makeConfig(ttl: string): SystemConfig {
  return {
    server: { access_token_ttl: ttl, jwt_secret_env: "JWT_SECRET" },
  } as unknown as SystemConfig;
}

/** 构造测试用户；password_hash 为哨兵值，用于断言其绝不出现在令牌中。 */
function makeUser(): User {
  return {
    id: "user-1",
    username: "admin",
    password_hash: "SENTINEL-PASSWORD-HASH",
    display_name: "Administrator",
    role: "admin",
    must_change_password: true,
    created_at: new Date(0).toISOString(),
    last_login_at: null,
  };
}

describe("JWT 签发与校验", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  /** 构建已注册 JWT 插件并 ready 的 Fastify 实例。 */
  async function buildApp(ttl = "45s") {
    const app = Fastify();
    apps.push(app);
    await registerJwt(app, makeConfig(ttl), SECRET);
    await app.ready();
    return app;
  }

  afterEach(async () => {
    vi.useRealTimers();
    while (apps.length) await apps.pop()!.close();
  });

  test("签名 → 校验往返成功，载荷严格为 { sub, username, role, iat, exp }", async () => {
    const app = await buildApp();
    const token = signAccessToken(app, makeUser());
    const payload = verifyAccessToken(app, token);
    expect(payload.sub).toBe("user-1");
    expect(payload.username).toBe("admin");
    expect(payload.role).toBe("admin");
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "role", "sub", "username"]);
  });

  test("载荷不含密钥 / 密码 / 哈希字段", async () => {
    const app = await buildApp();
    const token = signAccessToken(app, makeUser());
    const decoded = app.jwt.decode<Record<string, unknown>>(token)!;
    expect(Object.keys(decoded).sort()).toEqual(["exp", "iat", "role", "sub", "username"]);
    const raw = JSON.stringify(decoded);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SENTINEL-PASSWORD-HASH");
    expect(raw).not.toContain("password");
  });

  test("TTL 与 access_token_ttl 一致（45s / 12h）", async () => {
    const appShort = await buildApp("45s");
    const short = verifyAccessToken(appShort, signAccessToken(appShort, makeUser()));
    expect((short.exp ?? 0) - (short.iat ?? 0)).toBe(45);

    const appLong = await buildApp("12h");
    const long = verifyAccessToken(appLong, signAccessToken(appLong, makeUser()));
    expect((long.exp ?? 0) - (long.iat ?? 0)).toBe(12 * 3600);
  });

  test("篡改 token 校验失败并映射 AUTH_INVALID", async () => {
    const app = await buildApp();
    const token = signAccessToken(app, makeUser());
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(tampered).not.toBe(token);
    expect(() => verifyAccessToken(app, tampered)).toThrowError(VideoForgeError);
    expect(() => verifyAccessToken(app, tampered)).toThrowError(/AUTH_INVALID/);
  });

  test("过期 token 校验失败并映射 AUTH_INVALID", async () => {
    const app = await buildApp("1s");
    const token = signAccessToken(app, makeUser());
    expect(verifyAccessToken(app, token).sub).toBe("user-1");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5000);
    expect(() => verifyAccessToken(app, token)).toThrowError(/AUTH_INVALID/);
  });

  test("缺失 / 非法 token 校验失败并映射 AUTH_INVALID", async () => {
    const app = await buildApp();
    expect(() => verifyAccessToken(app, "")).toThrowError(/AUTH_INVALID/);
    expect(() => verifyAccessToken(app, "not-a-jwt")).toThrowError(/AUTH_INVALID/);
  });
});

describe("JWT 密钥加载（loadJwtSecret）", () => {
  const originalSecret = process.env.JWT_SECRET;
  let rootDir: string;

  beforeEach(() => {
    // 用空临时目录作为 rootDir，确保不读取真实 .env.local
    rootDir = mkdtempSync(join(tmpdir(), "vf-secret-"));
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  test("缺失 JWT_SECRET 时抛 CONFIG_INVALID", () => {
    expect(() => loadJwtSecret(makeConfig("12h"), rootDir)).toThrowError(VideoForgeError);
    expect(() => loadJwtSecret(makeConfig("12h"), rootDir)).toThrowError(/CONFIG_INVALID/);
  });

  test("长度小于 32 时抛 CONFIG_INVALID", () => {
    process.env.JWT_SECRET = "c".repeat(31);
    expect(() => loadJwtSecret(makeConfig("12h"), rootDir)).toThrowError(/CONFIG_INVALID/);
  });

  test("满足长度要求时正常读取", () => {
    const value = "d".repeat(32);
    process.env.JWT_SECRET = value;
    expect(loadJwtSecret(makeConfig("12h"), rootDir)).toBe(value);
  });
});
