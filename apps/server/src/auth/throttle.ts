import { normalizeUsername } from "../db/repositories/user-repository.js";

/**
 * 登录节流模块（见设计文档 §8.1「密码」）。
 * 进程内 Map 实现：同一 username（按 P4 归一化规则 lower-case 后比较）连续失败达到阈值后，
 * 在锁定窗口内一律拒绝；成功登录清零；进程重启即清零。
 * 阈值与窗口为代码常量，不进配置；admin 同样受约束，无例外。
 * 本模块只维护计数与锁定状态，不区分「密码错误」与「被节流」的对外文案（由调用方统一映射为 401）。
 */

/** 连续失败达到该次数即触发锁定。 */
export const LOGIN_FAILURE_LIMIT = 5;
/** 触发锁定后的拒绝窗口（毫秒）。 */
export const LOGIN_LOCK_DURATION_MS = 60_000;

/** 单个 username 的失败计数与锁定截止时间。 */
interface FailureRecord {
  /** 自上次清零以来的连续失败次数。 */
  count: number;
  /** 锁定截止时间戳（毫秒）；0 表示未锁定。 */
  lockedUntil: number;
}

/** username（归一化后）→ 失败记录。 */
const failures = new Map<string, FailureRecord>();

/** 节流状态，由调用方据此决定是否拒绝请求。 */
export interface ThrottleStatus {
  /** 当前是否处于拒绝窗口内。 */
  throttled: boolean;
  /** 距解除锁定还需的毫秒数；未锁定时为 0。 */
  retryAfterMs: number;
}

/**
 * 读取某个 username 的节流状态（不改变计数）。
 * @param username 用户名（内部按 lower-case 归一化）
 * @param now 当前时间戳（毫秒），默认 Date.now()，便于测试注入
 * @returns 节流状态
 */
export function getThrottleStatus(username: string, now: number = Date.now()): ThrottleStatus {
  const record = failures.get(normalizeUsername(username));
  if (!record || record.lockedUntil === 0) return { throttled: false, retryAfterMs: 0 };
  if (now < record.lockedUntil) {
    return { throttled: true, retryAfterMs: record.lockedUntil - now };
  }
  return { throttled: false, retryAfterMs: 0 };
}

/**
 * 记录一次登录失败并返回最新节流状态；连续失败达到阈值即锁定 LOGIN_LOCK_DURATION_MS。
 * 已过锁定窗口时重新计数，不在锁定期间的失败不延长既有窗口。
 * @param username 用户名（内部按 lower-case 归一化）
 * @param now 当前时间戳（毫秒），默认 Date.now()
 * @returns 更新后的节流状态
 */
export function registerLoginFailure(username: string, now: number = Date.now()): ThrottleStatus {
  const key = normalizeUsername(username);
  let record = failures.get(key);
  // 锁定窗口已过期：重置计数，开始新一轮统计
  if (!record || (record.lockedUntil !== 0 && now >= record.lockedUntil)) {
    record = { count: 0, lockedUntil: 0 };
  }
  record.count += 1;
  if (record.count >= LOGIN_FAILURE_LIMIT) {
    record.lockedUntil = now + LOGIN_LOCK_DURATION_MS;
  }
  failures.set(key, record);
  return getThrottleStatus(username, now);
}

/**
 * 登录成功后清零该 username 的失败计数与锁定状态。
 * @param username 用户名（内部按 lower-case 归一化）
 */
export function clearLoginFailures(username: string): void {
  failures.delete(normalizeUsername(username));
}

/**
 * 清空全部节流状态（仅供测试隔离使用）。
 */
export function resetLoginThrottle(): void {
  failures.clear();
}
