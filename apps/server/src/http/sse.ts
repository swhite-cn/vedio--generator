import type { FastifyReply } from "fastify";

/**
 * SSE 输出工具（见设计文档 §4.4）。
 *
 * Fastify 5 下 SSE 需在路由处理中调用 `reply.hijack()` 夺回连接控制权，随后直接向
 * `reply.raw` 写数据（不通过 `reply.send`）。本文件只提供帧格式化与心跳等工具函数，
 * **不含路由注册**（路由属 P9-B）。
 */

/** 心跳保活间隔（毫秒）。 */
export const SSE_HEARTBEAT_MS = 15_000;

/** 待输出的一帧 SSE 事件。 */
export interface SseEventFrame {
  /** 事件 id（可选，作为 `Last-Event-ID` 续传依据）。 */
  id?: string;
  /** 事件类型（对应 `SSE_EVENT_TYPES`）。 */
  type: string;
  /** 事件载荷（序列化为单行 JSON）。 */
  payload: unknown;
}

/**
 * 把一帧事件格式化为 SSE 文本。
 * 格式为（可选）`id: <id>\n` + `event: <type>\n` + `data: <单行JSON>\n\n`；
 * `data` 必须是单行 JSON（`JSON.stringify` 会转义内部换行），不得拆成多行。
 * @param event 待格式化事件帧
 * @returns SSE 文本
 */
export function formatSseEvent(event: SseEventFrame): string {
  const lines: string[] = [];
  if (event.id !== undefined) {
    lines.push(`id: ${event.id}`);
  }
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event.payload)}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * 向响应流写入一帧事件。
 * @param reply Fastify 响应对象（需已 `hijack`，`reply.raw` 可写）
 * @param event 待写入事件帧
 */
export function writeSseEvent(reply: FastifyReply, event: SseEventFrame): void {
  reply.raw.write(formatSseEvent(event));
}

/**
 * 向响应流写入一条 SSE 注释（用于心跳保活）。
 * @param reply Fastify 响应对象
 * @param comment 注释内容
 */
export function writeSseComment(reply: FastifyReply, comment: string): void {
  reply.raw.write(`: ${comment}\n\n`);
}

/**
 * 启动周期性心跳，定期向响应流写入 `: ping` 注释以保活。
 * 定时器会 `unref()`（如可用），避免阻止进程退出。
 * @param reply Fastify 响应对象
 * @param intervalMs 心跳间隔毫秒，缺省 `SSE_HEARTBEAT_MS`
 * @returns 停止心跳的函数（内部 `clearInterval`）
 */
export function startHeartbeat(
  reply: FastifyReply,
  intervalMs: number = SSE_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    writeSseComment(reply, "ping");
  }, intervalMs);
  // 不阻止进程退出。
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

/**
 * 返回 SSE 响应所需的 HTTP 头。
 * @returns 头字段键值对（含 `text/event-stream` 与 `no-cache`）
 */
export function getSseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}
