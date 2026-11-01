import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 密码哈希模块（见设计文档 §8.1「密码」）。
 * 采用 node:crypto 的 scrypt（零原生依赖，规避 Windows 原生模块构建问题）：
 * 参数固定 N=16384, r=8, p=1，salt 16 字节随机且逐用户独立。
 * 存储格式：`scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`。
 * 明文密码、派生哈希与 salt 均不得写入日志、YAML、trace 或测试快照。
 */

/** scrypt CPU/内存代价参数 N（2 的幂），见设计文档 §8.1。 */
const SCRYPT_N = 16384;
/** scrypt 块大小参数 r。 */
const SCRYPT_R = 8;
/** scrypt 并行度参数 p。 */
const SCRYPT_P = 1;
/** 每个用户独立随机 salt 的字节长度。 */
const SALT_BYTES = 16;
/** 派生密钥（哈希）字节长度。 */
const KEY_BYTES = 64;
/** 明文密码允许的最小长度（含）。 */
const MIN_PASSWORD_LENGTH = 8;
/** 明文密码允许的最大长度（含）。 */
const MAX_PASSWORD_LENGTH = 128;

/**
 * 校验明文密码长度（8..128）；越界抛 AUTH_INVALID。
 * 刻意不做大小写/符号复杂度强制——本机工具，复杂度策略只增加摩擦而无实际收益（见 §8.1）。
 * @param plain 明文密码
 */
function assertPasswordPolicy(plain: string): void {
  if (
    typeof plain !== "string" ||
    plain.length < MIN_PASSWORD_LENGTH ||
    plain.length > MAX_PASSWORD_LENGTH
  ) {
    throw new VideoForgeError(
      "AUTH_INVALID",
      `密码长度必须在 ${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} 之间`,
    );
  }
}

/**
 * 将明文密码哈希为可持久化的存储串。
 * @param plain 明文密码（长度 8..128）
 * @returns 形如 `scrypt$16384$8$1$<saltB64>$<hashB64>` 的存储串
 */
export function hashPassword(plain: string): string {
  assertPasswordPolicy(plain);
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * 校验明文密码是否匹配存储串。
 * 用 `timingSafeEqual` 做定长比较，避免时序侧信道；长度不等或存储串不合法时返回 false（不抛异常），
 * 以免通过异常差异泄露内部细节。
 * @param plain 候选明文密码
 * @param stored 数据库中的存储串
 * @returns 匹配为 true，否则 false
 */
export function verifyPassword(plain: string, stored: string): boolean {
  assertPasswordPolicy(plain);
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  // 字段数不为 6，或方案名不是 scrypt → 一律视为校验失败
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // 参数非整数或非正数 → 视为校验失败
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0
  ) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
  } catch {
    // 参数超出内存/取值上限等异常一律按校验失败处理，不向调用方冒泡
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
