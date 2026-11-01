import { describe, expect, test } from "vitest";
import {
  BUILT_IN_CAPABILITIES,
  getCapability,
  listCapabilities,
} from "../../apps/server/src/workflow/capabilities";
import { PIPELINE_STAGES, VideoForgeError } from "@videoforge/shared";

describe("内置能力注册表", () => {
  test("当前仅注册一项能力且 id 为 video-generation", () => {
    expect(BUILT_IN_CAPABILITIES).toHaveLength(1);
    expect(BUILT_IN_CAPABILITIES[0]?.id).toBe("video-generation");
  });

  test("阶段数为 7 且顺序逐项等于 PIPELINE_STAGES", () => {
    const stages = BUILT_IN_CAPABILITIES[0]?.stages ?? [];
    expect(stages).toHaveLength(7);
    expect(stages.map((stage) => stage.stage)).toEqual([...PIPELINE_STAGES]);
  });

  test("审核点恰为 copy 与 image", () => {
    expect(BUILT_IN_CAPABILITIES[0]?.reviewGates).toEqual(["copy", "image"]);
  });

  test("每个阶段都有非空 tool 与非空 artifact", () => {
    for (const stage of BUILT_IN_CAPABILITIES[0]?.stages ?? []) {
      expect(stage.tool).toBeTruthy();
      expect(stage.artifact).toBeTruthy();
    }
  });

  test("listCapabilities() 返回值可 JSON 序列化且 round-trip 后阶段顺序不变", () => {
    const views = listCapabilities();
    const roundTripped = JSON.parse(JSON.stringify(views)) as typeof views;
    // 若声明里混入函数字段，JSON.stringify 会丢弃该字段，round-trip 后即不相等。
    expect(roundTripped).toEqual(views);
    expect(roundTripped[0]?.stages.map((stage) => stage.stage)).toEqual([...PIPELINE_STAGES]);
    // 只读视图不携带 zod schema（非 JSON 序列化字段）。
    expect((roundTripped[0] as Record<string, unknown>).paramsSchema).toBeUndefined();
  });

  test("getCapability 对不存在的 id 返回 undefined", () => {
    expect(getCapability("not-exist")).toBeUndefined();
  });
});

describe("VideoForgeError 错误码", () => {
  test("PROJECT_BUSY 的 code 与 message 正确", () => {
    const error = new VideoForgeError("PROJECT_BUSY", "x");
    expect(error.code).toBe("PROJECT_BUSY");
    expect(error.message).toBe("PROJECT_BUSY: x");
  });
});
