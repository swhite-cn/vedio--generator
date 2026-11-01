import { loadLocalEnv } from "@videoforge/pipeline";

/**
 * Trace 与日志统一脱敏器（见设计文档 §7.4）。
 * 目标：让 `ARK_API_KEY`、`JWT_SECRET`、admin 初始口令等已知敏感值（含其常见环境变量名的赋值形态）
 * 在日志、trace.jsonl、SQLite 与 manifest 中一律以 `***` 出现。
 * 硬约束：敏感值本身不得被写入任何持久化面；`redactText` 不得因替换而抛出。
 */

/** 已知敏感环境变量名（其值不得进入日志 / trace / DB / manifest）。 */
const SENSITIVE_ENV_KEYS = ["ARK_API_KEY", "JWT_SECRET", "VF_ADMIN_INITIAL_PASSWORD"] as const;

/**
 * 内置 admin 默认初始口令（与 `apps/server/src/auth/bootstrap.ts` 的常量保持一致）。
 * 在此复刻为本地常量以避免 trace 层反向依赖 auth 模块。
 */
const BUILTIN_ADMIN_DEFAULT_PASSWORD = "mongoose-admin";

/** 参与替换的最小长度：短于该值的串不替换，避免误伤正常文本（见任务要求）。 */
const MIN_SECRET_LENGTH = 6;

/** 替换用的固定掩码。 */
const MASK = "***";

/**
 * 用于识别“键名后跟值”的敏感键名集合（大小写不敏感匹配）。
 * 精确名优先，其后为常见通用键名；使用 `\b` 边界避免误伤 `MONKEY` 之类的普通词。
 */
const SENSITIVE_KEY_WORDS =
  "ARK_API_KEY|JWT_SECRET|VF_ADMIN_INITIAL_PASSWORD|API_KEY|ACCESS_KEY|SECRET_KEY|PASSWORD|SECRET|TOKEN|CREDENTIALS?";

/** 形如 `KEY=value` / `KEY: value` 的赋值形态（键名为敏感键名时替换其值）。 */
const ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SENSITIVE_KEY_WORDS})\\b(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\\S+)`,
  "gi",
);

/** 形如 `--key value` / `--api-key=value` 的命令行参数形态。 */
const CLI_FLAG_PATTERN =
  /(--(?:api[-_]?key|key|secret|password|token|credential)s?)(\s+|=)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * 收集已知敏感值集合：加载 `.env.local` 后读取已知敏感环境变量，叠加内置 admin 默认口令与调用方附加值。
 * 结果去重，并过滤空串与过短值（长度 < 6 的短串不参与替换）。
 * @param rootDir 仓库根目录（用于定位 `.env.local`）
 * @param extra 调用方附加的敏感值（可选）
 * @returns 去重且已过滤的敏感值数组
 */
export function collectSensitiveValues(rootDir: string, extra: string[] = []): string[] {
  loadLocalEnv(rootDir);
  const candidates: string[] = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = process.env[key];
    if (value) candidates.push(value);
  }
  candidates.push(BUILTIN_ADMIN_DEFAULT_PASSWORD);
  candidates.push(...extra);

  const unique = new Set<string>();
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    if (raw.trim().length < MIN_SECRET_LENGTH) continue;
    unique.add(raw);
  }
  return [...unique];
}

/**
 * 对单段文本脱敏：先把敏感键名后紧跟的值替换为 `***`（赋值 / CLI 形态），再把已知敏感值子串整体替换为 `***`。
 * 已知值按长度降序替换，避免短值先替换破坏长值匹配；任何输入都不会抛出。
 * @param text 待脱敏文本
 * @param secrets 已知敏感值集合
 * @returns 脱敏后的文本
 */
export function redactText(text: string, secrets: string[]): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let result = text.replace(
    ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${MASK}`,
  );
  result = result.replace(
    CLI_FLAG_PATTERN,
    (_match, flag: string, separator: string) => `${flag}${separator}${MASK}`,
  );
  const sorted = [...secrets]
    .filter((s) => typeof s === "string" && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (!result.includes(secret)) continue;
    result = result.split(secret).join(MASK);
  }
  return result;
}

/**
 * 递归脱敏任意值：字符串走 `redactText`，数组逐项递归，对象逐键递归。
 * 传入循环引用时安全返回（不进入死循环），供 pino 日志兜底与 LLM 全文脱敏复用。
 * @param value 待脱敏值
 * @param secrets 已知敏感值集合
 * @returns 脱敏后的值（结构保持一致）
 */
export function redactDeep(value: unknown, secrets: string[]): unknown {
  return redactDeepInner(value, secrets, new WeakSet<object>());
}

/** `redactDeep` 的内部递归实现，携带 `seen` 集合防止循环引用。 */
function redactDeepInner(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeepInner(item, secrets, seen));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    output[key] = redactDeepInner(source[key], secrets, seen);
  }
  return output;
}

/**
 * 创建脱敏闭包：内部一次性收集并缓存敏感值集合，避免逐行重复读环境。
 * @param rootDir 仓库根目录（用于定位 `.env.local`）
 * @returns `(value) => unknown` 形式的脱敏函数
 */
export function createRedactor(rootDir: string): (value: unknown) => unknown {
  const secrets = collectSensitiveValues(rootDir);
  return (value: unknown) => redactDeep(value, secrets);
}
