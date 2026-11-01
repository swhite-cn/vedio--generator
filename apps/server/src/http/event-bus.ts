/**
 * 会话级 SSE 事件总线（见设计文档 §4.4）。
 *
 * SSE 事件 id 策略（受控偏差，登记到实施计划）：
 * 设计文档 §4.4 原文称事件 id「等于落库后的主键 id」，但主文档 §11 明确「刻意不建 `events` 表」，
 * 故不存在“事件行的主键”。本实现改为：id 采用事件总线内**全局单调递增的十进制序列号**
 * （`"1"`、`"2"`…），保证严格递增、唯一、可比较，作为 `Last-Event-ID` 续传依据。
 * 不新建 `events` 表，也不改动任何 schema。
 */

/** 每个会话保留的最近事件条数（见设计文档 §4.4）。 */
export const EVENT_BUFFER_SIZE = 200;

/** 全部 SSE 事件类型（逐字照搬设计文档 §4.4，顺序即定义顺序）。 */
export const SSE_EVENT_TYPES = [
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

/** SSE 事件类型联合。 */
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** 一条已发布会话事件。 */
export interface SessionEvent {
  /** 全局单调递增十进制序列号，字符串形式（SSE `id:` 取值）。 */
  id: string;
  /** 归属会话 id。 */
  sessionId: string;
  /** 事件类型。 */
  type: SseEventType;
  /** 事件载荷。 */
  payload: Record<string, unknown>;
  /** 发布时间的 ISO 字符串。 */
  at: string;
}

/** 事件总线接口。 */
export interface EventBus {
  /**
   * 发布一条会话事件：分配全局自增 id、打时间戳、写入会话环形缓冲并同步投递给活订阅者。
   * @param sessionId 会话 id
   * @param type 事件类型
   * @param payload 事件载荷
   * @returns 已构造并发布的事件
   */
  publish(sessionId: string, type: SseEventType, payload: Record<string, unknown>): SessionEvent;

  /**
   * 订阅某会话的后续事件。
   * @param sessionId 会话 id
   * @param listener 事件回调
   * @returns 取消订阅函数；重复调用幂等
   */
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;

  /**
   * 依据 `Last-Event-ID` 回放续传事件。
   * - `lastEventId` 为空/undefined：首连不回放历史，返回 `{ events: [], resync: false }`；
   * - 命中缓冲中某事件：返回其**之后**的全部事件（保持原顺序）+ `resync: false`；
   * - 未命中（缓冲为空、id 不存在、id 已被挤出、非本总线分配的 id 等）：
   *   返回 `{ events: [], resync: true }`（无法保证连续性时的安全语义）。
   * @param sessionId 会话 id
   * @param lastEventId 客户端上次收到的事件 id
   * @returns 续传事件列表与是否需要重同步
   */
  replay(sessionId: string, lastEventId?: string): { events: SessionEvent[]; resync: boolean };

  /**
   * 返回某会话当前环形缓冲中的事件条数（供测试与监控）。
   * @param sessionId 会话 id
   * @returns 缓冲内事件条数
   */
  bufferSize(sessionId: string): number;
}

/** 定长环形缓冲：超出容量时丢弃最旧元素（数组端 `shift`）。 */
class RingBuffer<T> {
  private readonly capacity: number;
  private items: T[] = [];

  /**
   * @param capacity 容量上限（至少为 1）
   */
  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * 追加一个元素，超容量时丢弃最旧元素。
   * @param item 待追加元素
   */
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  /**
   * 返回缓冲内元素快照（最旧 → 最新）。
   * @returns 元素数组副本
   */
  toArray(): T[] {
    return [...this.items];
  }

  /**
   * 返回当前元素条数。
   * @returns 元素条数
   */
  size(): number {
    return this.items.length;
  }
}

/** `createEventBus` 的可选参数。 */
export interface CreateEventBusOptions {
  /** 每会话环形缓冲容量，缺省 `EVENT_BUFFER_SIZE`。 */
  bufferSize?: number;
  /** 时钟注入（返回毫秒时间戳），缺省 `Date.now`。 */
  now?: () => number;
}

/**
 * 创建事件总线。
 * @param options 可选配置（缓冲容量与时钟注入）
 * @returns EventBus 实例
 */
export function createEventBus(options: CreateEventBusOptions = {}): EventBus {
  const bufferSize = options.bufferSize ?? EVENT_BUFFER_SIZE;
  const now = options.now ?? Date.now;

  /** 会话 id → 环形缓冲。 */
  const buffers = new Map<string, RingBuffer<SessionEvent>>();
  /** 会话 id → 活订阅者集合。 */
  const subscribers = new Map<string, Set<(event: SessionEvent) => void>>();
  /** 全局单调递增序列号（跨会话共享，保证全局唯一递增）。 */
  let sequence = 0;

  /** 取或创建某会话的环形缓冲。 */
  function getBuffer(sessionId: string): RingBuffer<SessionEvent> {
    let buffer = buffers.get(sessionId);
    if (!buffer) {
      buffer = new RingBuffer<SessionEvent>(bufferSize);
      buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  return {
    publish(sessionId: string, type: SseEventType, payload: Record<string, unknown>): SessionEvent {
      sequence += 1;
      const event: SessionEvent = {
        id: String(sequence),
        sessionId,
        type,
        payload,
        at: new Date(now()).toISOString(),
      };

      getBuffer(sessionId).push(event);

      const listeners = subscribers.get(sessionId);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (listenerError) {
            // 单个订阅者异常不得影响其它订阅者与 publish 结果。
            console.warn(`[event-bus] 订阅者处理事件 ${event.id} 失败`, listenerError);
          }
        }
      }

      return event;
    },

    subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
      let listeners = subscribers.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(sessionId, listeners);
      }
      const target = listeners;
      target.add(listener);

      let removed = false;
      return () => {
        if (removed) {
          return;
        }
        removed = true;
        target.delete(listener);
        if (target.size === 0) {
          subscribers.delete(sessionId);
        }
      };
    },

    replay(sessionId: string, lastEventId?: string): { events: SessionEvent[]; resync: boolean } {
      // 首连不回放历史：前端自行全量拉取。
      if (!lastEventId) {
        return { events: [], resync: false };
      }

      const buffer = buffers.get(sessionId);
      if (!buffer) {
        return { events: [], resync: true };
      }

      const all = buffer.toArray();
      const index = all.findIndex((event) => event.id === lastEventId);
      if (index < 0) {
        // 未命中：id 不存在、已被挤出或非本总线分配，无法保证连续性。
        return { events: [], resync: true };
      }

      return { events: all.slice(index + 1), resync: false };
    },

    bufferSize(sessionId: string): number {
      return buffers.get(sessionId)?.size() ?? 0;
    },
  };
}
