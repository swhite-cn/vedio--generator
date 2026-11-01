import type { FastifyInstance } from "fastify";
import { VideoForgeError, type VideoForgeErrorCode } from "@videoforge/shared";

/**
 * HTTP 错误映射与统一错误处理（见设计文档 §4.5、§8.3）。
 *
 * 职责：
 * - 把内核稳定错误码 `VideoForgeErrorCode` 映射到 HTTP 状态码；
 * - 统一 HTTP 错误响应体为 `{ error: { code, message } }`；
 * - 注册 Fastify 错误处理器与 404 处理器。
 *
 * 说明：本文件只提供错误处理框架，具体的路由注册与接线属后续阶段（P9-B/C）。
 */

/**
 * 错误码到 HTTP 状态码的映射（见设计文档 §4.5，`PATH_OUTSIDE_STORAGE` 见 §8.3）。
 * 注意：`QUALITY_BLOCKED` / `EVENT_IMMUTABLE` 文档未列，按内核失败归 500。
 */
export const ERROR_STATUS: Readonly<Record<VideoForgeErrorCode, number>> = {
  AUTH_INVALID: 401,
  AUTH_FORBIDDEN: 403,
  PROJECT_BUSY: 409,
  RUN_STATE_INVALID: 409,
  CONFIG_INVALID: 400,
  PATH_OUTSIDE_STORAGE: 403,
  TOOL_UNAVAILABLE: 500,
  ADAPTER_FAILED: 500,
  ADAPTER_PROTOCOL_INVALID: 500,
  // 以下两者文档未列，按内核失败归 500。
  QUALITY_BLOCKED: 500,
  EVENT_IMMUTABLE: 500,
};

/**
 * 未预期错误的 HTTP 响应体错误码取值。
 * 注意：它**不是** `VideoForgeErrorCode` 成员，`VideoForgeError` 永不携带；
 * 属本阶段补充的 HTTP 层取值（受控偏差，登记到实施计划）。
 */
export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR";

/**
 * 资源不存在时 404 响应体的错误码取值。
 * 注意：它**不是** `VideoForgeErrorCode` 成员，仅作 HTTP 层取值（受控偏差）。
 */
export const NOT_FOUND_CODE = "NOT_FOUND";

/**
 * 剥离 `VideoForgeError.message` 的 `` `${code}: ` `` 前缀，返回原始描述。
 * @param error 领域业务异常
 * @returns 不含错误码前缀的原始描述；若 message 不以该前缀开头则原样返回
 */
export function describeError(error: VideoForgeError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * 把任意错误转换为统一的 HTTP 错误响应体 `{ error: { code, message } }`。
 * - `VideoForgeError`：透传稳定错误码，message 剥离 code 前缀；
 * - 其它（含 `Error` 与非 Error 值）：仅返回通用内部错误文案，绝不向客户端泄漏原始
 *   message 或堆栈；同时写一条 `console.error` 级日志（日志不含任何密钥/令牌）。
 * @param error 捕获到的错误对象或任意抛出值
 * @returns 统一错误响应体
 */
export function toErrorBody(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof VideoForgeError) {
    return { error: { code: error.code, message: describeError(error) } };
  }
  // 未预期错误：仅记录到服务端日志，响应体保持中性文案。
  console.error("[http] 未预期的内部错误", error);
  return { error: { code: INTERNAL_ERROR_CODE, message: "服务器内部错误" } };
}

/**
 * 解析错误对应的 HTTP 状态码。
 * @param error 捕获到的错误对象或任意抛出值
 * @returns `VideoForgeError` 取其映射状态码（未知码兜底 500）；其它一律 500
 */
export function resolveStatusCode(error: unknown): number {
  if (error instanceof VideoForgeError) {
    return ERROR_STATUS[error.code] ?? 500;
  }
  return 500;
}

/**
 * 注册 Fastify 统一错误处理器与 404 处理器。
 * - 错误处理器：用 `resolveStatusCode` 决定状态码、`toErrorBody` 生成响应体，
 *   并以 `request.log.error` 记录一条请求级日志；
 * - 404 处理器：返回 404 + `{ error: { code: NOT_FOUND_CODE, message: "资源不存在" } }`。
 * @param app Fastify 实例
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = resolveStatusCode(error);
    request.log.error({ err: error }, "[http] 请求处理失败");
    reply.code(statusCode).send(toErrorBody(error));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: NOT_FOUND_CODE, message: "资源不存在" } });
  });
}
