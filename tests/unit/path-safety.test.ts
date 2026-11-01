import { expect, test } from "vitest";
import { resolveArtifactPath } from "../../packages/pipeline/src/path-safety";

test("拒绝逃逸到存储根目录外的工件路径", () => {
  expect(() => resolveArtifactPath("C:/store", "../outside.mp4")).toThrow("PATH_OUTSIDE_STORAGE");
});

test("允许存储根目录内的工件路径", () => {
  expect(resolveArtifactPath("C:/store", "builds/b1/final.mp4")).toMatch(
    /[\\/]builds[\\/]b1[\\/]final\.mp4$/,
  );
});
