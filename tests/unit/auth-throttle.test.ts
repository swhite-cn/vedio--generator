import { afterEach, describe, expect, test } from "vitest";
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_LOCK_DURATION_MS,
  clearLoginFailures,
  getThrottleStatus,
  registerLoginFailure,
  resetLoginThrottle,
} from "../../apps/server/src/auth/throttle";

describe("登录节流（进程内 Map）", () => {
  afterEach(() => resetLoginThrottle());

  test("连续失败达到阈值后即被拒绝（第 6 次）", () => {
    const now = 1_000_000;
    // 前 4 次失败尚未触发锁定
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i += 1) {
      expect(registerLoginFailure("alice", now).throttled).toBe(false);
    }
    // 第 5 次失败触发锁定
    expect(registerLoginFailure("alice", now).throttled).toBe(true);
    // 第 6 次（及以后）一律拒绝，剩余窗口为完整锁定时长
    const status = getThrottleStatus("alice", now);
    expect(status.throttled).toBe(true);
    expect(status.retryAfterMs).toBe(LOGIN_LOCK_DURATION_MS);
  });

  test("不足阈值时不被拒绝", () => {
    const now = 2_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i += 1) registerLoginFailure("bob", now);
    expect(getThrottleStatus("bob", now).throttled).toBe(false);
  });

  test("成功登录后清零", () => {
    const now = 3_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) registerLoginFailure("carol", now);
    expect(getThrottleStatus("carol", now).throttled).toBe(true);
    clearLoginFailures("carol");
    expect(getThrottleStatus("carol", now).throttled).toBe(false);
  });

  test("admin 同样受节流，无例外", () => {
    const now = 4_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) registerLoginFailure("admin", now);
    expect(getThrottleStatus("admin", now).throttled).toBe(true);
  });

  test("username 按 lower-case 归一化后计数", () => {
    const now = 5_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) registerLoginFailure("Admin", now);
    expect(getThrottleStatus("admin", now).throttled).toBe(true);
    expect(getThrottleStatus("ADMIN", now).throttled).toBe(true);
  });

  test("锁定窗口到期后自动解除", () => {
    const now = 6_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) registerLoginFailure("dave", now);
    expect(getThrottleStatus("dave", now + LOGIN_LOCK_DURATION_MS - 1).throttled).toBe(true);
    expect(getThrottleStatus("dave", now + LOGIN_LOCK_DURATION_MS).throttled).toBe(false);
  });

  test("锁定窗口内再次失败不延长既有窗口", () => {
    const now = 7_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) registerLoginFailure("erin", now);
    const before = getThrottleStatus("erin", now).retryAfterMs;
    registerLoginFailure("erin", now);
    expect(getThrottleStatus("erin", now).retryAfterMs).toBe(before);
  });
});
