import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendGenerationRecord,
  GENERATION_MANIFEST_PATH,
  readGenerationRecords,
  resolveSceneScope,
} from "../../packages/pipeline/src/index";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-manifest-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("生成清单：追加式落盘", () => {
  test("写入后可在 manifest/generations.jsonl 读回，且记录提示词与摘要", () => {
    const record = appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      model: "image-model",
      promptSet: "default",
      prompt: "霓虹街道。画面中不要出现文字",
      params: { size: "2K" },
      ok: true,
    });

    expect(record.promptSha256).toBeTruthy();
    expect(record.createdAt).toMatch(/T/);
    const path = join(projectDir, GENERATION_MANIFEST_PATH);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(1);
    expect(readGenerationRecords(projectDir)).toEqual([record]);
  });

  test("同一场景重新生成产生新记录，并通过 supersedesId 串成版本链", () => {
    const first = appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      prompt: "第一版",
      ok: true,
    });
    const second = appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      prompt: "第二版",
      ok: true,
    });

    expect(second.supersedesId).toBe(first.id);
    expect(readGenerationRecords(projectDir)).toHaveLength(2);
  });

  test("不同场景互不覆盖，也不会错误串联版本", () => {
    const a = appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      prompt: "a",
      ok: true,
    });
    const b = appendGenerationRecord(projectDir, {
      stage: "image",
      sceneId: "s2",
      assetPath: "images/s2.png",
      prompt: "b",
      ok: true,
    });

    expect(b.supersedesId).toBeUndefined();
    expect(a.id).not.toBe(b.id);
  });

  test("失败记录同样保留，便于解释降级与失败原因", () => {
    const record = appendGenerationRecord(projectDir, {
      stage: "scene",
      sceneId: "s3",
      assetPath: "scenes/s3.html",
      ok: false,
      errorCode: "ADAPTER_PROTOCOL_INVALID",
      errorMessage: "场景模型未输出合法 JSON",
    });

    expect(record.ok).toBe(false);
    expect(readGenerationRecords(projectDir)[0]).toMatchObject({
      errorCode: "ADAPTER_PROTOCOL_INVALID",
      ok: false,
    });
  });

  test("清单中的损坏行被跳过，不影响其余记录读取", () => {
    appendGenerationRecord(projectDir, {
      stage: "tts",
      sceneId: "s1",
      assetPath: "audio/s1.mp3",
      ok: true,
    });
    const path = join(projectDir, GENERATION_MANIFEST_PATH);
    writeFileSync(path, `\n{不是合法 JSON}\n${readFileSync(path, "utf-8")}`, "utf-8");

    expect(readGenerationRecords(projectDir)).toHaveLength(1);
  });

  test("manifest 目录缺失时自动创建", () => {
    expect(existsSync(join(projectDir, "manifest"))).toBe(false);
    appendGenerationRecord(projectDir, { stage: "copy", assetPath: "copy.json", ok: true });
    expect(existsSync(join(projectDir, "manifest", "generations.jsonl"))).toBe(true);
  });
});

describe("生成清单：场景范围归一化", () => {
  test("未指定范围时返回全部场景（保持文档顺序）", () => {
    expect(resolveSceneScope(["s1", "s2", "s3"])).toEqual(["s1", "s2", "s3"]);
    expect(resolveSceneScope(["s1", "s2"], [])).toEqual(["s1", "s2"]);
  });

  test("指定范围时去重并按文档顺序返回", () => {
    expect(resolveSceneScope(["s1", "s2", "s3"], ["s3", "s1", "s3"])).toEqual(["s1", "s3"]);
  });

  test("未知场景 ID 抛 CONFIG_INVALID 并列出可选值", () => {
    expect(() => resolveSceneScope(["s1", "s2"], ["s9"])).toThrowError(/CONFIG_INVALID/);
    expect(() => resolveSceneScope(["s1", "s2"], ["s9"])).toThrowError(/s1, s2/);
  });
});
