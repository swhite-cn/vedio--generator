import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PROJECT_MANIFEST_FILE,
  ensureProjectManifest,
  readProjectManifest,
  writeProjectManifest,
} from "../../packages/pipeline/src/index";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-project-manifest-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("项目清单 manifest.json", () => {
  test("不存在时创建并写入契约版本与主题", () => {
    const manifest = ensureProjectManifest(projectDir, {
      contractVersion: "2.0",
      themeId: "documentary-dark",
      now: "2026-11-04T00:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      version: "1",
      contractVersion: "2.0",
      themeId: "documentary-dark",
      createdAt: "2026-11-04T00:00:00.000Z",
    });
    expect(readProjectManifest(projectDir)).toEqual(manifest);

    const onDisk = JSON.parse(
      readFileSync(join(projectDir, PROJECT_MANIFEST_FILE), "utf-8"),
    ) as Record<string, unknown>;
    expect(onDisk.contractVersion).toBe("2.0");
  });

  test("已存在时不覆盖历史快照", () => {
    ensureProjectManifest(projectDir, {
      contractVersion: "1.0",
      themeId: "theme-a",
      now: "2026-11-04T00:00:00.000Z",
    });
    const second = ensureProjectManifest(projectDir, {
      contractVersion: "2.0",
      themeId: "theme-b",
      now: "2026-11-05T00:00:00.000Z",
    });

    expect(second.contractVersion).toBe("1.0");
    expect(second.themeId).toBe("theme-a");
  });

  test("文件缺失时返回 null", () => {
    expect(readProjectManifest(projectDir)).toBeNull();
  });

  test("旧清单缺少版本字段时按 1.0 归一化", () => {
    writeFileSync(
      join(projectDir, PROJECT_MANIFEST_FILE),
      JSON.stringify({ createdAt: "2026-01-01", updatedAt: "2026-01-01" }),
      "utf-8",
    );
    const manifest = readProjectManifest(projectDir);
    expect(manifest?.contractVersion).toBe("1.0");
    expect(manifest?.themeId).toBeNull();
    expect(manifest?.version).toBe("1");
  });

  test("非 JSON 清单抛 ADAPTER_PROTOCOL_INVALID", () => {
    writeFileSync(join(projectDir, PROJECT_MANIFEST_FILE), "不是 JSON", "utf-8");
    expect(() => readProjectManifest(projectDir)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  test("写入非法契约版本时拒绝", () => {
    expect(() =>
      writeProjectManifest(projectDir, {
        version: "1",
        contractVersion: "v2",
        themeId: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });
});
