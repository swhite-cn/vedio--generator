import { describe, expect, it } from "vitest";
import { PIPELINE_STAGES, REVIEW_GATE_STAGES } from "@videoforge/shared";

/**
 * T004 起 `PIPELINE_STAGES` 已合并为 v2 八阶段（`captions` 独立字幕轨）。
 * 影子常量 `PIPELINE_STAGES_V2` 已删除，本文件锁定合并后的顺序与审核点。
 */
describe("PIPELINE_STAGES 八阶段", () => {
  it("为八阶段且字幕位于配音之后、时间轴之前", () => {
    expect(PIPELINE_STAGES).toHaveLength(8);
    expect(PIPELINE_STAGES.indexOf("captions")).toBe(4);
    expect(PIPELINE_STAGES[3]).toBe("tts");
    expect(PIPELINE_STAGES[5]).toBe("storyboard");
  });

  it("阶段顺序与设计文档 §4.4 逐项一致", () => {
    expect([...PIPELINE_STAGES]).toEqual([
      "copy",
      "image",
      "scene",
      "tts",
      "captions",
      "storyboard",
      "render",
      "compose",
    ]);
  });

  it("审核点仍固定在 copy 与 image 之后", () => {
    expect([...REVIEW_GATE_STAGES]).toEqual(["copy", "image"]);
  });
});
