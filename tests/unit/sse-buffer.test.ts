import { afterEach, describe, expect, test, vi } from "vitest";
import type { FastifyReply } from "fastify";
import {
  EVENT_BUFFER_SIZE,
  SSE_EVENT_TYPES,
  createEventBus,
  type SessionEvent,
} from "../../apps/server/src/http/event-bus";
import {
  SSE_HEARTBEAT_MS,
  formatSseEvent,
  getSseHeaders,
  startHeartbeat,
  writeSseComment,
  writeSseEvent,
} from "../../apps/server/src/http/sse";

/**
 * SSE 事件总线与输出工具单测（P9-A）。
 * 只覆盖 `event-bus.ts` / `sse.ts` 的纯逻辑与帧格式化，不启动 HTTP、不加载 Pi/Playwright。
 */

/** 构造一个只收集写入内容的假 FastifyReply，用于断言 SSE 输出。 */
function createFakeReply(): { reply: FastifyReply; writes: string[] } {
  const writes: string[] = [];
  const reply = {
    raw: {
      write: (chunk: string): boolean => {
        writes.push(chunk);
        return true;
      },
    },
  } as unknown as FastifyReply;
  return { reply, writes };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createEventBus: 事件构造与 id 分配", () => {
  test("id 为十进制数字字符串，且跨会话仍全局严格递增", () => {
    const bus = createEventBus({ now: () => 0 });
    const a = bus.publish("s1", "text_delta", { text: "a" });
    const b = bus.publish("s2", "text_delta", { text: "b" });
    const c = bus.publish("s1", "text_delta", { text: "c" });

    expect(/^\d+$/.test(a.id)).toBe(true);
    expect(Number(b.id)).toBeGreaterThan(Number(a.id));
    expect(Number(c.id)).toBeGreaterThan(Number(b.id));
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  test("事件携带正确的 sessionId / type / payload / ISO 时间戳", () => {
    const fixed = 1_700_000_000_000;
    const bus = createEventBus({ now: () => fixed });
    const event = bus.publish("session-x", "run_end", { runId: "r1", status: "done" });

    expect(event.sessionId).toBe("session-x");
    expect(event.type).toBe("run_end");
    expect(event.payload).toEqual({ runId: "r1", status: "done" });
    expect(event.at).toBe(new Date(fixed).toISOString());
  });

  test("SSE_EVENT_TYPES 覆盖 §4.4 十种事件类型", () => {
    expect(SSE_EVENT_TYPES).toEqual([
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
    ]);
  });
});

describe("createEventBus: 环形缓冲上限", () => {
  test("bufferSize=3 时发 5 条只保留最近 3 条，最早那条已被挤出", () => {
    const bus = createEventBus({ bufferSize: 3, now: () => 0 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(bus.publish("s", "text_delta", { text: String(i) }).id);
    }

    expect(bus.bufferSize("s")).toBe(3);
    // 命中仍存在的最早 id，可取到后续事件
    const replay = bus.replay("s", ids[2]);
    expect(replay.resync).toBe(false);
    expect(replay.events.map((event) => event.id)).toEqual([ids[3], ids[4]]);
    // 已被挤出的 id 无法续传
    expect(bus.replay("s", ids[0])).toEqual({ events: [], resync: true });
  });

  test("默认容量常量为 200", () => {
    expect(EVENT_BUFFER_SIZE).toBe(200);
  });

  test("阈值行为：bufferSize=5 时发 6 条只保留 5 条", () => {
    const bus = createEventBus({ bufferSize: 5, now: () => 0 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(bus.publish("s", "text_delta", { text: String(i) }).id);
    }

    expect(bus.bufferSize("s")).toBe(5);
    expect(bus.replay("s", ids[0]).resync).toBe(true);
    expect(bus.replay("s", ids[1]).resync).toBe(false);
  });
});

describe("createEventBus: 订阅", () => {
  test("活订阅者按发布顺序收到事件；取消后不再收到；重复取消不抛", () => {
    const bus = createEventBus({ now: () => 0 });
    const received: string[] = [];
    const seen: SessionEvent[] = [];
    const unsubscribe = bus.subscribe("s", (event) => {
      seen.push(event);
      received.push(event.id);
    });

    const e1 = bus.publish("s", "text_delta", { n: 1 });
    const e2 = bus.publish("s", "text_delta", { n: 2 });
    expect(received).toEqual([e1.id, e2.id]);

    unsubscribe();
    bus.publish("s", "text_delta", { n: 3 });
    expect(received).toEqual([e1.id, e2.id]);
    expect(seen.map((event) => event.type)).toEqual(["text_delta", "text_delta"]);

    // 重复取消幂等
    expect(() => unsubscribe()).not.toThrow();
  });

  test("单个订阅者抛异常不影响其它订阅者，也不影响 publish 返回值", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = createEventBus({ now: () => 0 });
    const good: string[] = [];
    bus.subscribe("s", () => {
      throw new Error("boom");
    });
    bus.subscribe("s", (event) => good.push(event.id));

    const event = bus.publish("s", "text_delta", { n: 1 });
    expect(good).toEqual([event.id]);
    expect(event.id).toBe("1");
    expect(warn).toHaveBeenCalled();
  });
});

describe("createEventBus: replay 续传", () => {
  test("无 Last-Event-ID 时首连不回放历史", () => {
    const bus = createEventBus({ now: () => 0 });
    bus.publish("s", "text_delta", { n: 1 });
    expect(bus.replay("s")).toEqual({ events: [], resync: false });
    expect(bus.replay("s", undefined)).toEqual({ events: [], resync: false });
  });

  test("命中缓冲：返回其后的事件且顺序正确", () => {
    const bus = createEventBus({ bufferSize: 3, now: () => 0 });
    const e1 = bus.publish("s", "text_delta", { n: 1 });
    const e2 = bus.publish("s", "text_delta", { n: 2 });
    const e3 = bus.publish("s", "text_delta", { n: 3 });

    const replay = bus.replay("s", e1.id);
    expect(replay.resync).toBe(false);
    expect(replay.events.map((event) => event.id)).toEqual([e2.id, e3.id]);
  });

  test("id 已被挤出：resync=true", () => {
    const bus = createEventBus({ bufferSize: 2, now: () => 0 });
    const e1 = bus.publish("s", "text_delta", { n: 1 });
    bus.publish("s", "text_delta", { n: 2 });
    bus.publish("s", "text_delta", { n: 3 });

    expect(bus.replay("s", e1.id)).toEqual({ events: [], resync: true });
  });

  test("未知 id：resync=true", () => {
    const bus = createEventBus({ now: () => 0 });
    bus.publish("s", "text_delta", { n: 1 });
    expect(bus.replay("s", "999999")).toEqual({ events: [], resync: true });
  });
});

describe("createEventBus: 会话隔离", () => {
  test("会话 A 的事件不出现在会话 B 的 replay 结果里", () => {
    const bus = createEventBus({ now: () => 0 });
    const a1 = bus.publish("A", "text_delta", { n: 1 });
    const a2 = bus.publish("A", "text_delta", { n: 2 });
    const b1 = bus.publish("B", "text_delta", { n: 3 });

    const replayA = bus.replay("A", a1.id);
    expect(replayA.events.map((event) => event.id)).toEqual([a2.id]);
    expect(replayA.events.every((event) => event.sessionId === "A")).toBe(true);

    // 跨会话 id 不命中
    expect(bus.replay("B", a1.id)).toEqual({ events: [], resync: true });
    expect(bus.replay("A", b1.id)).toEqual({ events: [], resync: true });
  });
});

describe("formatSseEvent", () => {
  test("含 id 时首行 id、次行 event、第三行单行 data，以空行结尾", () => {
    const payload = { text: "hi\nx" };
    const text = formatSseEvent({ id: "7", type: "text_delta", payload });
    const lines = text.split("\n");

    expect(lines[0]).toBe("id: 7");
    expect(lines[1]).toBe("event: text_delta");
    expect(lines[2].startsWith("data: ")).toBe(true);
    expect(lines[2].includes("\n")).toBe(false);
    expect(JSON.parse(lines[2].slice("data: ".length))).toEqual(payload);
    expect(text.endsWith("\n\n")).toBe(true);
  });

  test("不含 id 时首行直接是 event 行", () => {
    const text = formatSseEvent({ type: "error", payload: { code: "X", message: "y" } });
    const lines = text.split("\n");
    expect(lines[0]).toBe("event: error");
    expect(lines[1].startsWith("data: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
  });
});

describe("SSE 输出与心跳", () => {
  test("writeSseEvent 写入格式化后的帧", () => {
    const { reply, writes } = createFakeReply();
    writeSseEvent(reply, { id: "1", type: "run_end", payload: { status: "done" } });
    const joined = writes.join("");
    expect(joined).toContain("id: 1");
    expect(joined).toContain("event: run_end");
    expect(joined.endsWith("\n\n")).toBe(true);
  });

  test("writeSseComment 输出注释行", () => {
    const { reply, writes } = createFakeReply();
    writeSseComment(reply, "ping");
    expect(writes[writes.length - 1]).toBe(": ping\n\n");
  });

  test("startHeartbeat 周期性写心跳，停止后不再写", () => {
    vi.useFakeTimers();
    const { reply, writes } = createFakeReply();
    const stop = startHeartbeat(reply, 1000);

    vi.advanceTimersByTime(3000);
    const pings = (): number => writes.filter((chunk) => chunk === ": ping\n\n").length;
    expect(pings()).toBe(3);

    stop();
    vi.advanceTimersByTime(1000);
    expect(pings()).toBe(3);
  });

  test("SSE_HEARTBEAT_MS 为 15000 毫秒", () => {
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
  });

  test("getSseHeaders 含 text/event-stream 与 no-cache", () => {
    const headers = getSseHeaders();
    expect(headers["Content-Type"]).toContain("text/event-stream");
    expect(headers["Cache-Control"]).toContain("no-cache");
    expect(headers.Connection).toBe("keep-alive");
  });
});
