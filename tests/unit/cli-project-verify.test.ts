import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyProjectArtifacts } from "../../apps/cli/src/project-verify";
import { getCapability } from "../../apps/server/src/workflow/capabilities";
import { seedV2Project } from "./helpers/v2-project-fixture";

/** 测试使用的输出 Profile 名（与能力声明中 render 阶段 glob 的 `<profile>` 占位对应）。 */
const PROFILE = "landscape-1080p";

/** 夹具 timeline v2 的总时长（2 镜 × 4000ms + 尾停顿 500ms）。 */
const TIMELINE_MS = 8500;

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

/**
 * 造一个产物齐全的 v2 项目目录：v2 结构产物（copy/cues/spec/captions/timeline）
 * 由共享夹具写出，再补 images / 渲染帧 / final.mp4 三个二进制类产物。
 * @returns 临时项目目录绝对路径
 */
function makeFullProjectDir(): string {
  const dir = makeProjectDir({
    "images/s1.png": "png",
    [`build/render/${PROFILE}/frames/f1.jpg`]: "jpg",
    "final.mp4": "mp4",
  });
  seedV2Project(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("project:verify.verifyProjectArtifacts（§3.5 只读体检）", () => {
  const declaration = getCapability("video-generation")!;

  it("产物齐全且时长在容差内 → ok true、consistent true", async () => {
    const projectDir = makeFullProjectDir();
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => TIMELINE_MS + 100,
    });
    expect(report.final?.consistent).toBe(true);
    expect(report.stages.every((stage) => stage.ok)).toBe(true);
    expect(report.ok).toBe(true);
    // 未显式传契约版本时按 v2 处理（新项目一律 v2）
    expect(report.contractVersion).toBe("2.0");
  });

  it("存量 v1 项目 → 输出契约版本、给出迁移提示并判 ok false", async () => {
    const projectDir = makeProjectDir({
      "copy.json": JSON.stringify({
        topic: "黑洞",
        style: "科普",
        title: "黑洞不是洞",
        scenes: [],
      }),
    });
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      contractVersion: "1.0",
      probe: async () => TIMELINE_MS,
    });
    expect(report.contractVersion).toBe("1.0");
    expect(report.hints.some((hint) => hint.includes("无法续跑"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("成片时长严重偏离 timeline → consistent false、hints 含偏差提示、ok false", async () => {
    const projectDir = makeFullProjectDir();
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => TIMELINE_MS + 9000,
    });
    expect(report.final?.consistent).toBe(false);
    expect(report.hints.some((hint) => hint.includes("偏差"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("缺 timeline.json → final.consistent 为 null", async () => {
    const projectDir = makeFullProjectDir();
    rmSync(join(projectDir, "timeline.json"));
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: PROFILE,
      ffprobePath: "ffprobe",
      probe: async () => TIMELINE_MS + 100,
    });
    expect(report.final?.exists).toBe(true);
    expect(report.final?.timelineMs).toBeNull();
    expect(report.final?.consistent).toBeNull();
  });

  it("probe 抛错时降级为提示，不使命令失败", async () => {
    const projectDir = makeFullProjectDir();
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
