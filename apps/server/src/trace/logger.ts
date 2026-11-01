import type { FastifyServerOptions } from "fastify";

/**
 * Fastify 5 结构化日志配置工厂（见设计文档 §7.4）。
 * 本文件只提供配置对象，不改动 `apps/server/src/app.ts` 的启动方式（接线属 P9）。
 * 脱敏分两层：
 * - Pino `redact`：按已知敏感字段路径（请求头令牌 / cookie、各类密钥字段）做结构化脱敏；
 * - `formatters.log` 兜底：对整条日志对象递归走 `redactDeep`，确保已知敏感**值**不出现。
 */

/** Fastify 允许的 logger 选项类型（去掉 `boolean`，即配置对象形态）。 */
export type ServerLoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

/** 需要按路径脱敏的已知敏感字段（Pino `redact` 语义）。 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.token",
  "*.secret",
];

/**
 * 构造 Fastify logger 配置：JSON 行输出，级别取自环境变量 `LOG_LEVEL`（缺省 `info`）。
 * @param redactor 值级脱敏函数（通常来自 `createRedactor(rootDir)`）
 * @returns 可直接传给 `Fastify({ logger })` 的配置对象
 */
export function createLoggerOptions(redactor: (value: unknown) => unknown): ServerLoggerOptions {
  const level = process.env.LOG_LEVEL?.trim() || "info";
  const options = {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "***",
    },
    formatters: {
      /**
       * 兜底脱敏：对每次日志调用的对象整体递归替换已知敏感值，避免字段路径覆盖不到的泄漏。
       */
      log(object: Record<string, unknown>): Record<string, unknown> {
        return redactor(object) as Record<string, unknown>;
      },
    },
  } satisfies ServerLoggerOptions;
  return options;
}
