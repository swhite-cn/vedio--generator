import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCopyDoc, writeCopyDoc } from "../../packages/pipeline/src/copy-contract";

const sample = {
  topic: "黑洞",
  style: "科普",
  title: "黑洞是什么",
  scenes: [
    { sceneId: "s1", title: "引入", narration: "黑洞是……", imagePrompt: "深空中的黑洞插画" },
  ],
};

describe("copy.json 契约", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("写入后能在中文路径下读回且内容一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const path = join(dir, "文案 1.json");
    writeCopyDoc(path, sample);
    expect(readCopyDoc(path)).toEqual(sample);
  });

  it("写入时自动创建缺失的父目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const path = join(dir, "工作区 甲", "copy.json");
    writeCopyDoc(path, sample);
    expect(readCopyDoc(path)).toEqual(sample);
  });

  it("缺少 scenes 的文件抛 ADAPTER_PROTOCOL_INVALID", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ topic: "x" }), "utf-8");
    expect(() => readCopyDoc(bad)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("非 JSON 内容抛 ADAPTER_PROTOCOL_INVALID", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-"));
    dirs.push(dir);
    const bad = join(dir, "not-json.json");
    writeFileSync(bad, "这不是 JSON", "utf-8");
    expect(() => readCopyDoc(bad)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });
});
