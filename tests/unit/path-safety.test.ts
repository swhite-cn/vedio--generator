import { expect, test } from "vitest";
import {
  isWindowsReservedName,
  resolveArtifactPath,
  validateProjectName,
} from "../../packages/pipeline/src/path-safety";

test("拒绝逃逸到存储根目录外的工件路径", () => {
  expect(() => resolveArtifactPath("C:/store", "../outside.mp4")).toThrow("PATH_OUTSIDE_STORAGE");
});

test("允许存储根目录内的工件路径", () => {
  expect(resolveArtifactPath("C:/store", "builds/b1/final.mp4")).toMatch(
    /[\\/]builds[\\/]b1[\\/]final\.mp4$/,
  );
});

test("拒绝 Windows 保留设备名作为工件名（如误由 `2>nul` 落盘的 nul）", () => {
  expect(() => resolveArtifactPath("C:/store", "nul")).toThrow("PATH_OUTSIDE_STORAGE");
  expect(() => resolveArtifactPath("C:/store", "builds/nul")).toThrow("PATH_OUTSIDE_STORAGE");
});

test("isWindowsReservedName：与 Windows 口径一致（首个点之前的主名、去空白、不区分大小写）", () => {
  for (const name of ["nul", "NUL", "Nul", "nul.txt", " nul ", "con", "COM1", "lpt9.log"]) {
    expect(isWindowsReservedName(name)).toBe(true);
  }
  for (const name of ["null", "readme.txt", "concept", "com0", "lpt10"]) {
    expect(isWindowsReservedName(name)).toBe(false);
  }
});

test("项目名不能是 Windows 保留设备名（否则无法作为目录落盘）", () => {
  expect(() => validateProjectName("nul")).toThrow("PATH_OUTSIDE_STORAGE");
  expect(() => validateProjectName("CON")).toThrow("PATH_OUTSIDE_STORAGE");
  expect(validateProjectName("科普 视频")).toBe("科普 视频");
});
