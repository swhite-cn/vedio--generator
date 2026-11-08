import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCopyDoc,
  readCopyDocument,
  writeCopyDocV2,
} from "../../packages/pipeline/src/copy-contract";

/** v2 fixture 路径。 */
const V2_FIXTURE = join(__dirname, "..", "fixtures", "contracts-v2", "copy-v2.json");

/** v1 样例：不带 contractVersion，模拟存量项目。 */
const V1_SAMPLE = {
  topic: "黑洞",
  style: "科普",
  title: "黑洞是什么",
  scenes: [
    { sceneId: "s1", title: "引入", narration: "黑洞是……", imagePrompt: "深空中的黑洞插画" },
  ],
};

describe("copy.json 版本兼容读取", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** 创建临时目录并写入指定内容。 */
  function writeTemp(content: unknown, fileName = "copy.json"): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-copy-version-"));
    dirs.push(dir);
    const path = join(dir, fileName);
    writeFileSync(path, JSON.stringify(content), "utf-8");
    return path;
  }

  it("无 contractVersion 视为 v1", () => {
    const document = readCopyDocument(writeTemp(V1_SAMPLE));
    expect(document.version).toBe("1");
    expect(document.doc).toEqual(V1_SAMPLE);
  });

  it("contractVersion=2.0 解析为 v2", () => {
    const document = readCopyDocument(V2_FIXTURE);
    expect(document.version).toBe("2");
    if (document.version === "2") {
      expect(document.doc.scenes[0].shots).toHaveLength(2);
      expect(document.doc.contractVersion).toBe("2.0");
    }
  });

  it("未知版本抛 ADAPTER_PROTOCOL_INVALID", () => {
    const path = writeTemp({ ...V1_SAMPLE, contractVersion: "3.0" });
    expect(() => readCopyDocument(path)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
    expect(() => readCopyDocument(path)).toThrowError(/3\.0/);
  });

  it("v2 文档传给 readCopyDoc 时给出明确提示", () => {
    expect(() => readCopyDoc(V2_FIXTURE)).toThrowError(/v2/);
  });

  it("v2 结构非法时抛 v2 结构错误", () => {
    const broken = JSON.parse(readFileSync(V2_FIXTURE, "utf-8")) as Record<string, unknown>;
    delete broken.scenes;
    const path = writeTemp(broken);
    expect(() => readCopyDocument(path)).toThrowError(/v2 结构非法/);
  });

  it("writeCopyDocV2 可在中文路径下写回并读回", () => {
    const source = readCopyDocument(V2_FIXTURE);
    if (source.version !== "2") throw new Error("fixture 必须是 v2");

    const dir = mkdtempSync(join(tmpdir(), "vf-copy-v2-"));
    dirs.push(dir);
    const path = join(dir, "文案 2", "copy.json");
    writeCopyDocV2(path, source.doc);

    const readBack = readCopyDocument(path);
    expect(readBack.version).toBe("2");
    expect(readBack.doc).toEqual(source.doc);
  });
});
