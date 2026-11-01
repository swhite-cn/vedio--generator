import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyProjectArtifacts } from "../../apps/cli/src/project-verify";
import { getCapability } from "../../apps/server/src/workflow/capabilities";

/** 测试使用的输出 Profile 名（与能力声明中 render 阶段 glob 的 `<profile>` 占位对应）。 */
const PROFILE = "landscape-1080p";

/** 临时项目目录登记表，afterEach 统一清理。 */
const tempDirs: string[] = [];

/**
 * 造一个临时项目目录并写入指定文件。
 * @param files 相对项目目录的文件路径 → 内容
 * @returns 临时项目目录绝对路径
 */
function makeProjectDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-verify-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf-8");
  }
  return dir;
}

/** 生成一套契约齐全的产物文件表（不含 timeline.json，由用例按需补齐）。 */
function fullArtifactFiles(): Record<string, string> {
  return {
    "copy.json": JSON.stringify({
      topic: "黑洞",
      style: "科普",
      title: "黑洞是什么",
      scenes: [{ sceneId: "s1", title: "引入", narration: "黑洞是……", imagePrompt: "深空黑洞" }],
    }),
    "images/s1.png": "png",
    "scenes/s1.html": "<html></html>",
    "audio/s1.mp3": "mp3",
    [`build/render/${PROFILE}/frames/f1.jpg`]: "jpg",
    "final.mp4": "mp4",
  };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("project:verify.verifyProjectArtifacts（§3.5 只读体检）", () => {
  const declaration = getCapability("video-generation")!;

  it("产物齐全且时长在容差内 → ok true、consistent true", async () => {
    const projectDir = makeProjectDir({
      ...fullArtifactFiles(),
      "timeline.json": JSON.stringify({ entries: [], totalMs: 1000 }),
    });
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => 1100,
    });
    expect(report.final?.consistent).toBe(true);
    expect(report.stages.every((stage) => stage.ok)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("成片时长严重偏离 timeline → consistent false、hints 含偏差提示、ok false", async () => {
    const projectDir = makeProjectDir({
      ...fullArtifactFiles(),
      "timeline.json": JSON.stringify({ entries: [], totalMs: 1000 }),
    });
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => 9000,
    });
    expect(report.final?.consistent).toBe(false);
    expect(report.hints.some((hint) => hint.includes("偏差"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("缺 timeline.json → final.consistent 为 null", async () => {
    const projectDir = makeProjectDir(fullArtifactFiles());
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => 1100,
    });
    expect(report.final?.exists).toBe(true);
    expect(report.final?.timelineMs).toBeNull();
    expect(report.final?.consistent).toBeNull();
  });

  it("probe 抛错时降级为提示，不使命令失败", async () => {
    const projectDir = makeProjectDir({
      ...fullArtifactFiles(),
      "timeline.json": JSON.stringify({ entries: [], totalMs: 1000 }),
    });
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => {
        throw new Error("ffprobe 不可用");
      },
    });
    expect(report.final?.videoMs).toBeNull();
    expect(report.final?.consistent).toBeNull();
    expect(report.hints.some((hint) => hint.includes("ffprobe"))).toBe(true);
  });
});
