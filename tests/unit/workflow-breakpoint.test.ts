import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ArtifactPredicate } from "@videoforge/shared";
import { getCapability } from "../../apps/server/src/workflow/capabilities";
import { resolveBreakpoint, verifyStageArtifact } from "../../apps/server/src/workflow/breakpoint";

/**
 * 产物判据解释器与断点扫描单测（Phase 8 Step 2）。
 * 使用真实临时项目目录，覆盖 file/glob 达标与不达标、`<profile>` 替换、
 * copy-contract 校验失败、timeline-contract 降级路径与 `resolveBreakpoint` 结果。
 */

let projectDir: string;

/** 在项目目录内写文件（自动创建父目录）。 */
function writeProjectFile(relativePath: string, content: string): void {
  const target = join(projectDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
}

/** 合法的 copy.json 文本（通过 copy-contract 校验）。 */
function validCopyJson(): string {
  return JSON.stringify({
    topic: "黑洞是什么",
    style: "科普",
    title: "黑洞",
    scenes: [
      {
        sceneId: "s1",
        title: "引言",
        narration: "黑洞是时空中的一个区域。",
        imagePrompt: "深空中的黑洞",
      },
    ],
  });
}

/** 构造 `video-generation` 全阶段产物（用于“全部达标”用例）。 */
function writeAllArtifacts(): void {
  writeProjectFile("copy.json", validCopyJson());
  writeProjectFile("images/cover.png", "png");
  writeProjectFile("scenes/s1.html", "<html></html>");
  writeProjectFile("audio/s1.mp3", "mp3");
  writeProjectFile("timeline.json", JSON.stringify({ scenes: [] }));
  writeProjectFile("build/render/landscape-1080p/frames/0001.jpg", "jpg");
  writeProjectFile("final.mp4", "mp4");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-breakpoint-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("verifyStageArtifact：file 判据", () => {
  test("文件存在且无校验器 → 达标", () => {
    writeProjectFile("final.mp4", "mp4");
    const predicate: ArtifactPredicate = { kind: "file", relativePath: "final.mp4" };
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(true);
  });

  test("文件缺失 → 不达标", () => {
    const predicate: ArtifactPredicate = { kind: "file", relativePath: "final.mp4" };
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("copy-contract：合法内容达标，非法内容不达标", () => {
    const predicate: ArtifactPredicate = {
      kind: "file",
      relativePath: "copy.json",
      validator: "copy-contract",
    };

    writeProjectFile("copy.json", validCopyJson());
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(true);

    writeProjectFile("copy.json", JSON.stringify({ topic: "x" }));
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("copy-contract：非 JSON 文本不达标", () => {
    writeProjectFile("copy.json", "not json");
    const predicate: ArtifactPredicate = {
      kind: "file",
      relativePath: "copy.json",
      validator: "copy-contract",
    };
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("timeline-contract 降级：JSON 可解析即达标，非法 JSON 不达标", () => {
    const predicate: ArtifactPredicate = {
      kind: "file",
      relativePath: "timeline.json",
      validator: "timeline-contract",
    };

    writeProjectFile("timeline.json", JSON.stringify({ any: "shape" }));
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(true);

    writeProjectFile("timeline.json", "{broken");
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("路径越界（..）按未达标处理，不抛错", () => {
    const predicate: ArtifactPredicate = { kind: "file", relativePath: "../escape.txt" };
    expect(() =>
      expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false),
    ).not.toThrow();
  });
});

describe("verifyStageArtifact：glob 判据", () => {
  test("命中数达到 minCount 才达标", () => {
    const predicate: ArtifactPredicate = { kind: "glob", pattern: "images/*.png", minCount: 2 };

    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);

    writeProjectFile("images/a.png", "a");
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);

    writeProjectFile("images/b.png", "b");
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(true);
  });

  test("扩展名不匹配的文件不计入", () => {
    writeProjectFile("images/a.txt", "a");
    const predicate: ArtifactPredicate = { kind: "glob", pattern: "images/*.png", minCount: 1 };
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("目录不存在 → 不达标（不抛错）", () => {
    const predicate: ArtifactPredicate = { kind: "glob", pattern: "images/*.png", minCount: 1 };
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(false);
  });

  test("<profile> 占位符按传入 profile 替换", () => {
    const predicate: ArtifactPredicate = {
      kind: "glob",
      pattern: "build/render/<profile>/frames/*.jpg",
      minCount: 1,
    };

    writeProjectFile("build/render/landscape-1080p/frames/0001.jpg", "jpg");
    expect(verifyStageArtifact(projectDir, predicate, "landscape-1080p")).toBe(true);
    expect(verifyStageArtifact(projectDir, predicate, "portrait-1080p")).toBe(false);
  });
});

describe("resolveBreakpoint：断点扫描", () => {
  const declaration = getCapability("video-generation")!;

  test("无任何产物 → 从第 0 阶段开始，skipped 为空", () => {
    const result = resolveBreakpoint(projectDir, declaration, "landscape-1080p");
    expect(result.startIndex).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  test("仅 copy 达标 → 从 image 开始，skipped=[copy]", () => {
    writeProjectFile("copy.json", validCopyJson());
    const result = resolveBreakpoint(projectDir, declaration, "landscape-1080p");
    expect(result.startIndex).toBe(1);
    expect(result.skipped).toEqual(["copy"]);
  });

  test("前 3 阶段达标（copy/image/scene）→ 从 tts 开始", () => {
    writeProjectFile("copy.json", validCopyJson());
    writeProjectFile("images/a.png", "a");
    writeProjectFile("scenes/a.html", "<html></html>");
    const result = resolveBreakpoint(projectDir, declaration, "landscape-1080p");
    expect(result.startIndex).toBe(3);
    expect(result.skipped).toEqual(["copy", "image", "scene"]);
  });

  test("全部达标 → startIndex 等于阶段数，skipped 为全部阶段", () => {
    writeAllArtifacts();
    const result = resolveBreakpoint(projectDir, declaration, "landscape-1080p");
    expect(result.startIndex).toBe(declaration.stages.length);
    expect(result.skipped).toEqual(declaration.stages.map((stage) => stage.stage));
  });

  test("compose 产物 final.mp4 缺失但前置全达标 → 从 compose 开始", () => {
    writeAllArtifacts();
    rmSync(join(projectDir, "final.mp4"));
    const result = resolveBreakpoint(projectDir, declaration, "landscape-1080p");
    expect(result.startIndex).toBe(declaration.stages.length - 1);
    expect(result.skipped).toEqual(declaration.stages.slice(0, -1).map((stage) => stage.stage));
  });
});
