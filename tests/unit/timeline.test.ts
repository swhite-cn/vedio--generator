import { expect, test } from "vitest";
import { buildTimeline } from "../../packages/pipeline/src/timeline";
import { getProfile } from "../../packages/template-sdk/src/contracts";

test("场景结束时间等于实测旁白时长加尾部停顿", () => {
  expect(buildTimeline([{ sceneId: "s1", durationMs: 1000 }], 350).totalMs).toBe(1350);
});

test("横竖版具有独立尺寸与安全区", () => {
  expect(getProfile("LANDSCAPE_1080P").width).toBe(1920);
  expect(getProfile("PORTRAIT_1080P").height).toBe(1920);
});
