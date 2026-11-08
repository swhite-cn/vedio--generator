import { describe, expect, test, vi } from "vitest";
import type { TimelineDocV2 } from "@videoforge/shared";
import {
  createPlayerMessageHandler,
  createReadyMessage,
  type PlayerController,
} from "../../apps/player/src/protocol.js";
import { sliceTimelineForShot } from "../../packages/remotion-engine/src/slice.js";

/**
 * Player 协议与镜头切片的单测（T208）。
 * 纯函数直测，不加载 React/浏览器环境。
 */

/** 构造最小 timeline v2（两镜头）。 */
function makeTimeline(): TimelineDocV2 {
  return {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 0,
    timingSource: "estimated",
    totalMs: 2000,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
    ],
    cues: [
      { cueId: "c1", shotId: "sh-001", kind: "narration", startMs: 0, endMs: 1000, text: "一" },
      { cueId: "c2", shotId: "sh-002", kind: "narration", startMs: 1000, endMs: 2000, text: "二" },
    ],
  };
}

describe("createPlayerMessageHandler（postMessage 协议）", () => {
  /** 记录型控制器。 */
  function makeController(): PlayerController & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      seek: (timeMs) => calls.push(`seek:${timeMs}`),
      play: () => calls.push("play"),
      pause: () => calls.push("pause"),
      setShot: (shotId) => calls.push(`shot:${shotId}`),
    };
  }

  test("四类命令正确分发到控制器", () => {
    const controller = makeController();
    const handle = createPlayerMessageHandler(controller);
    handle({ type: "player:seek", timeMs: 500 });
    handle({ type: "player:play" });
    handle({ type: "player:pause" });
    handle({ type: "player:shot", shotId: "sh-002" });
    expect(controller.calls).toEqual(["seek:500", "play", "pause", "shot:sh-002"]);
  });

  test("畸形载荷与未知类型静默忽略（协议向后兼容）", () => {
    const controller = makeController();
    const handle = createPlayerMessageHandler(controller);
    handle({ type: "player:seek", timeMs: -1 });
    handle({ type: "player:seek", timeMs: "x" });
    handle({ type: "player:shot", shotId: "  " });
    handle({ type: "unknown:event" });
    handle(null);
    handle("text");
    expect(controller.calls).toEqual([]);
  });

  test("ready 消息携带当前镜头", () => {
    expect(createReadyMessage("sh-001")).toEqual({ type: "player:ready", shotId: "sh-001" });
    expect(createReadyMessage(null)).toEqual({ type: "player:ready", shotId: null });
  });
});

describe("sliceTimelineForShot（单镜头预览切片）", () => {
  test("目标镜头平移到 0ms，cue 同步平移且只保留本镜", () => {
    const { timeline } = sliceTimelineForShot(makeTimeline(), "sh-002");
    expect(timeline.shots).toEqual([
      { shotId: "sh-002", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
    ]);
    expect(timeline.totalMs).toBe(1000);
    expect(timeline.cues).toEqual([
      { cueId: "c2", shotId: "sh-002", kind: "narration", startMs: 0, endMs: 1000, text: "二" },
    ]);
  });

  test("带 specShots 时切出目标镜头规格", () => {
    const spec = {
      shotId: "sh-001",
      visualType: "component" as const,
      componentId: "keyword-block",
      props: { title: "一" },
      assetRefs: [],
      transition: { in: "hard-cut" as const, out: "hard-cut" as const },
      animations: [],
      source: null,
    };
    const { specShot } = sliceTimelineForShot(makeTimeline(), "sh-001", [spec]);
    expect(specShot?.componentId).toBe("keyword-block");
  });

  test("镜头不在时间轴内报 CONFIG_INVALID", () => {
    expect(() => sliceTimelineForShot(makeTimeline(), "no-such")).toThrowError(/no-such/);
  });
});
