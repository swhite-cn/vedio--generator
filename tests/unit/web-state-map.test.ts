/**
 * 状态映射纯函数单测（Web 专题 §2.3「状态色映射（唯一权威表）」）。
 *
 * 覆盖三张映射表（项目 5 态 / run 6 态含 INTERRUPTED 语义 / 阶段 5 态含 skipped）
 * 与随状态变化的 Tooltip 文案，确保全站状态文案与颜色不偏离权威表。
 */
import { describe, expect, test } from "vitest";
import {
  INTERRUPTED_TOOLTIP,
  SKIPPED_TOOLTIP,
  STAGE_LABELS,
  mapProjectStatus,
  mapRunStatus,
  mapStageStatus,
  statusTooltip,
} from "../../apps/web/src/components/state-mapping";

describe("mapProjectStatus", () => {
  test("maps the five project statuses to the authoritative text and color", () => {
    expect(mapProjectStatus("draft")).toEqual({ text: "草稿", color: "default" });
    expect(mapProjectStatus("running")).toEqual({ text: "运行中", color: "processing" });
    expect(mapProjectStatus("review")).toEqual({ text: "待审核", color: "warning" });
    expect(mapProjectStatus("done")).toEqual({ text: "已完成", color: "success" });
    expect(mapProjectStatus("failed")).toEqual({ text: "失败", color: "error" });
  });

  test("falls back to a gray tag with the raw text for an unknown status", () => {
    expect(mapProjectStatus("mystery")).toEqual({ text: "mystery", color: "default" });
  });
});

describe("mapRunStatus", () => {
  test("maps the five stable run statuses", () => {
    expect(mapRunStatus("queued")).toEqual({ text: "排队中", color: "default" });
    expect(mapRunStatus("running")).toEqual({ text: "运行中", color: "processing" });
    expect(mapRunStatus("waiting_review")).toEqual({ text: "待审核", color: "warning" });
    expect(mapRunStatus("done")).toEqual({ text: "已完成", color: "success" });
    expect(mapRunStatus("failed")).toEqual({ text: "失败", color: "error" });
  });

  test("renders canceled as 已取消 by default", () => {
    expect(mapRunStatus("canceled")).toEqual({ text: "已取消", color: "default" });
    expect(mapRunStatus("canceled", null)).toEqual({ text: "已取消", color: "default" });
  });

  test("renders canceled with INTERRUPTED error code as 已中断", () => {
    expect(mapRunStatus("canceled", "INTERRUPTED")).toEqual({ text: "已中断", color: "default" });
  });
});

describe("mapStageStatus", () => {
  test("maps the five stage statuses to text, color and step status", () => {
    expect(mapStageStatus("pending")).toEqual({
      text: "待执行",
      color: "default",
      stepStatus: "wait",
    });
    expect(mapStageStatus("running")).toEqual({
      text: "运行中",
      color: "processing",
      stepStatus: "process",
    });
    expect(mapStageStatus("done")).toEqual({
      text: "已完成",
      color: "success",
      stepStatus: "finish",
    });
    expect(mapStageStatus("failed")).toEqual({ text: "失败", color: "error", stepStatus: "error" });
    expect(mapStageStatus("skipped")).toEqual({
      text: "已跳过",
      color: "default",
      stepStatus: "finish",
    });
  });

  test("falls back to a waiting gray step for an unknown stage status", () => {
    expect(mapStageStatus("mystery")).toEqual({
      text: "mystery",
      color: "default",
      stepStatus: "wait",
    });
  });
});

describe("statusTooltip", () => {
  test("adds the interrupted tooltip only for canceled runs with INTERRUPTED", () => {
    expect(statusTooltip("run", "canceled", "INTERRUPTED")).toBe(INTERRUPTED_TOOLTIP);
    expect(statusTooltip("run", "canceled")).toBe("");
    expect(statusTooltip("run", "canceled", "OTHER")).toBe("");
    expect(statusTooltip("run", "failed", "INTERRUPTED")).toBe("");
  });

  test("adds the skipped tooltip for skipped stages", () => {
    expect(statusTooltip("stage", "skipped")).toBe(SKIPPED_TOOLTIP);
    expect(statusTooltip("stage", "done")).toBe("");
  });

  test("never adds a tooltip for project statuses", () => {
    expect(statusTooltip("project", "failed")).toBe("");
  });
});

describe("STAGE_LABELS", () => {
  test("exposes the seven fixed stage labels in order", () => {
    expect(Object.keys(STAGE_LABELS)).toEqual([
      "copy",
      "image",
      "scene",
      "tts",
      "storyboard",
      "render",
      "compose",
    ]);
    expect(STAGE_LABELS.compose).toBe("合成");
  });
});
