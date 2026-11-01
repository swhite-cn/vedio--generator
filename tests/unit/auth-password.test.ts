import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../../apps/server/src/auth/password";
import { VideoForgeError } from "../../packages/shared/src/errors";

describe("密码哈希（scrypt）", () => {
  const storedFormat = /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;

  test("hashPassword 输出严格遵循 scrypt$N$r$p$salt$hash 格式", () => {
    const hash = hashPassword("correct-horse");
    expect(hash).toMatch(storedFormat);
    // 字段数严格为 6，参数为固定值
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    // salt 为 16 字节随机值的 base64
    expect(Buffer.from(parts[4], "base64")).toHaveLength(16);
  });

  test("verifyPassword 正例通过、反例失败", () => {
    const hash = hashPassword("s3cret-pass");
    expect(verifyPassword("s3cret-pass", hash)).toBe(true);
    expect(verifyPassword("s3cret-pasS", hash)).toBe(false);
    expect(verifyPassword("another-pass", hash)).toBe(false);
  });

  test("相同明文因随机 salt 产生不同存储串，但两者均可校验通过", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  test("非法存储串一律返回 false 且不抛异常", () => {
    const invalidStored = [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$YWJj", // 字段数不足
      "bcrypt$16384$8$1$YWJj$ZGVm", // 方案名不是 scrypt
      "scrypt$0$0$0$YWJj$ZGVm", // 参数非正数
      "scrypt$a$b$c$YWJj$ZGVm", // 参数非数字
      "scrypt$16384$8$1$$", // salt 与 hash 为空
      "scrypt$16384$8$1$YWJj$", // hash 为空
    ];
    for (const stored of invalidStored) {
      expect(() => verifyPassword("some-password", stored)).not.toThrow();
      expect(verifyPassword("some-password", stored)).toBe(false);
    }
  });

  test("明文长度 7 与 129 被拒（抛 AUTH_INVALID），8 与 128 允许", () => {
    expect(() => hashPassword("1".repeat(7))).toThrowError(VideoForgeError);
    expect(() => hashPassword("1".repeat(7))).toThrowError(/AUTH_INVALID/);
    expect(() => hashPassword("1".repeat(129))).toThrowError(/AUTH_INVALID/);

    const valid = hashPassword("1".repeat(8));
    expect(() => verifyPassword("1".repeat(7), valid)).toThrowError(/AUTH_INVALID/);
    expect(() => verifyPassword("1".repeat(129), valid)).toThrowError(/AUTH_INVALID/);

    expect(() => hashPassword("1".repeat(8))).not.toThrow();
    expect(() => hashPassword("1".repeat(128))).not.toThrow();
    expect(verifyPassword("1".repeat(8), valid)).toBe(true);
  });
});
