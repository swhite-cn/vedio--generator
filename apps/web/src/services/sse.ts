/**
 * 会话事件流（SSE）客户端（见 Web 专题 §5.4.5）。
 *
 * 采用「短时票据」方案：`EventSource` 不支持自定义请求头，故先 `POST /api/sessions/:id/events-ticket`
 * 取回 `{ ticket, expiresInMs }`（Bearer 鉴权 + 会话归属校验），再以
 * `GET /api/sessions/:id/events?ticket=<票据>` 建连；**不使用** `?token=` 查询参数。
 *
 * 重连语义：票据 TTL 为 60 秒，浏览器自动重连时旧票据可能已过期，
 * 因此**重连 = 重新签票 + 重新建连**（不复用旧票据）；连续失败达阈值后通知 UI 断线。
 */
import { apiRequest } from "./api";

/** 连续失败达到该次数即通知 UI "实时连接已断开"。 */
export const SSE_DISCONNECT_THRESHOLD = 3;

/** 断线后重新签票 + 建连的退避间隔（毫秒）。 */
const RECONNECT_DELAY_MS = 2_000;

/**
 * 服务端会以 `event: <type>` 命名帧下发的事件类型（见主文档 §4.4）。
 * `EventSource` 只对无名事件触发 `onmessage`，命名事件需逐类型 `addEventListener`，故此处显式列出。
 */
const NAMED_EVENT_TYPES = [
  "text_delta",
  "tool_start",
  "tool_end",
  "turn_end",
  "run_start",
  "run_stage",
  "review_gate",
  "run_end",
  "resync",
  "error",
] as const;

/** 解析后的一帧 SSE 事件。 */
export interface SseFrame {
  /** 事件 id（服务端下发的单调递增序列号）。 */
  id?: string;
  /** 事件类型（`event:` 字段；缺省为 `message`）。 */
  type: string;
  /** 事件载荷（`data:` 字段 JSON 解析结果；解析失败时为原始字符串）。 */
  data: unknown;
}

/** 连接状态回调载荷。 */
export interface SseStatus {
  /** `connected`：连接可用；`disconnected`：连续失败达阈值。 */
  state: "connected" | "disconnected";
}

/** `subscribeSessionEvents` 的参数。 */
export interface SessionEventsOptions {
  /** 目标会话 id。 */
  sessionId: string;
  /** 收到一帧事件时回调；`resync` 也经此回调，调用方据此丢弃缓存并全量重拉。 */
  onEvent: (frame: SseFrame) => void;
  /** 连接状态变化回调。 */
  onStatus?: (status: SseStatus) => void;
}

/**
 * 解析单帧 SSE 文本（纯函数，便于单测）。
 * 支持字段顺序任意、忽略注释行（以 `:` 开头）与空行行尾；`data:` 多行按 `\n` 拼接后尝试 JSON 解析。
 * @param raw 单帧原始文本
 * @returns 解析结果；既无 `event:` 也无 `data:` 时返回 null
 */
export function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/);
  let id: string | undefined;
  let type = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const field = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).replace(/^ /, "");
    if (field === "id") {
      id = value;
    } else if (field === "event") {
      type = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (type.length === 0 && dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");
  let data: unknown = rawData;
  if (rawData.length > 0) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }

  const frame: SseFrame = { type: type.length > 0 ? type : "message", data };
  if (id !== undefined) {
    frame.id = id;
  }
  return frame;
}

/**
 * 判断连续失败次数是否已达断线通知阈值（纯函数，便于单测）。
 * @param failureCount 连续失败次数
 * @returns 达到阈值返回 true
 */
export function shouldNotifyDisconnected(failureCount: number): boolean {
  return failureCount >= SSE_DISCONNECT_THRESHOLD;
}

/**
 * 订阅某会话的事件流。
 * @param options 订阅参数（会话 id、事件回调、状态回调）
 * @returns 取消订阅函数：关闭连接并停止重连（离开页面时调用）
 */
export function subscribeSessionEvents(options: SessionEventsOptions): () => void {
  const { sessionId, onEvent, onStatus } = options;
  const eventsUrl = () => `/api/sessions/${encodeURIComponent(sessionId)}/events`;

  let source: EventSource | null = null;
  let closed = false;
  let failureCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 关闭当前 EventSource（忽略其后端自动重连，改由本模块控制重连节奏）。 */
  function closeSource(): void {
    if (source) {
      source.close();
      source = null;
    }
  }

  /** 处理一次连接失败：计数、按需通知断线、退避后重新签票建连。 */
  function handleFailure(): void {
    if (closed) {
      return;
    }
    closeSource();
    failureCount += 1;
    if (shouldNotifyDisconnected(failureCount)) {
      onStatus?.({ state: "disconnected" });
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_DELAY_MS);
  }

  /** 重新签票并建立连接（重连不复用旧票据）。 */
  async function connect(): Promise<void> {
    if (closed) {
      return;
    }
    try {
      const ticketResponse = await apiRequest<{ ticket: string; expiresInMs: number }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/events-ticket`,
        { method: "POST" },
      );
      if (closed) {
        return;
      }
      const eventSource = new EventSource(
        `${eventsUrl()}?ticket=${encodeURIComponent(ticketResponse.ticket)}`,
      );
      source = eventSource;

      eventSource.onopen = () => {
        failureCount = 0;
        onStatus?.({ state: "connected" });
      };
      eventSource.onmessage = (event: MessageEvent) => {
        const frame = parseSseFrame(`data: ${String(event.data)}`);
        if (frame) {
          onEvent(frame);
        }
      };
      for (const type of NAMED_EVENT_TYPES) {
        // `error` 单列处理（见下），此处跳过，避免与传输层错误事件互相污染。
        if (type === "error") {
          continue;
        }
        eventSource.addEventListener(type, (event: Event) => {
          if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
            return;
          }
          const frame = parseSseFrame(`event: ${type}\ndata: ${event.data}`);
          if (frame) {
            onEvent(frame);
          }
        });
      }
      // 传输层错误与业务 `error` 帧在浏览器中是**同一事件类型**（`error`），
      // 只能靠事件对象类型区分：业务帧为 MessageEvent（带 data），传输层错误为普通 Event。
      // 若分设 `onerror` 与 `addEventListener("error")`，断线会被误当业务错误、业务错误会被误当断线。
      eventSource.addEventListener("error", (event: Event) => {
        if (event instanceof MessageEvent && typeof event.data === "string") {
          const frame = parseSseFrame(`event: error\ndata: ${event.data}`);
          if (frame) {
            onEvent(frame);
          }
          return;
        }
        console.warn("[web] SSE 连接中断，准备重新签票重连");
        handleFailure();
      });
    } catch (error) {
      console.warn("[web] 获取 SSE 票据失败", error);
      handleFailure();
    }
  }

  void connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    closeSource();
    console.info(`[web] 已关闭会话事件流：${sessionId}`);
  };
}
