/**
 * 展示格式化纯函数（Web 专题 §2.4「通用模式：时间显示」）。
 *
 * 全站时间统一 `YYYY-MM-DD HH:mm:ss`，耗时统一 `mm:ss`，文件体积统一带单位；
 * 空值一律回退 `-`，避免页面出现 `NaN` / `Invalid Date`。
 */
import dayjs from "dayjs";

/**
 * 格式化时间为 `YYYY-MM-DD HH:mm:ss`。
 * @param value 服务端 ISO 时间串（可为空）
 * @returns 格式化后的时间；空值或非法值返回 `-`
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm:ss") : "-";
}

/**
 * 把毫秒时长格式化为 `mm:ss`（超 1 小时进位为 `HH:mm:ss`）。
 * @param ms 毫秒时长（可为空）
 * @returns 格式化后的时长；空值或非法值返回 `-`
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 计算两次时间之间的耗时并格式化。
 * @param startAt 起始时间（可为空）
 * @param endAt 结束时间（可为空）
 * @returns 格式化后的耗时；任一缺失或非法返回 `-`
 */
export function formatElapsed(startAt: string | null, endAt: string | null): string {
  if (!startAt || !endAt) return "-";
  const start = dayjs(startAt).valueOf();
  const end = dayjs(endAt).valueOf();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-";
  return formatDurationMs(end - start);
}

/**
 * 计算从起始时间到指定时刻的耗时并格式化（用于展示运行中步骤的已耗时）。
 * @param startAt 起始时间（可为空）
 * @param now 当前时间戳（毫秒）
 * @returns 格式化后的耗时；起始缺失或非法返回 `-`
 */
export function formatRunningElapsed(startAt: string | null, now: number): string {
  if (!startAt) return "-";
  const start = dayjs(startAt).valueOf();
  if (!Number.isFinite(start)) return "-";
  return formatDurationMs(Math.max(0, now - start));
}

/**
 * 格式化文件体积。
 * @param bytes 字节数（可为空）
 * @returns 带单位的体积文案；空值或非法值返回 `-`
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
