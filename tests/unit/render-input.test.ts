import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareShotRenderInput } from "../../apps/server/src/domain/render-input";

/**
 * v2 渲染输入装配的单测（T204）。
 * 用临时目录构造真实项目产物（copy v2 / timeline v2 / 主题快照 / SceneSpec / images/），
 * 验证读取、映射与路径安全边界；不触发 Remotion。
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-render-input-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** 写 copy.json v2（两镜头：sh-001 可配 imagePath）。 */
function writeCopyV2(imagePath?: string): void {
  const doc = {
    contractVersion: "2.0",
    topic: "黑洞",
    style: "科普",
    title: "黑洞简介",
    theme: { id: "documentary-dark" },
    styleAnchors: [],
    scenes: [
      {
        sceneId: "s1",
        title: "开篇",
        shots: [
          {
            shotId: "sh-001",
            narration: "黑洞是时空的极端弯曲。",
            visualType: "image",
            ...(imagePath ? { imagePath } : {}),
          },
          { shotId: "sh-002", narration: "光也无法逃逸。", visualType: "component" },
        ],
      },
    ],
  };
  writeFileSync(join(projectDir, "copy.json"), JSON.stringify(doc), "utf-8");
}

/** 写最小合法 timeline v2。 */
function writeTimelineV2(): void {
  const doc = {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 0,
    timingSource: "estimated",
    totalMs: 2000,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 1000, durationMs: 1000 },
      { shotId: "sh-002", sceneId: "s1", startMs: 1000, endMs: 2000, durationMs: 1000 },
    ],
    cues: [],
  };
  writeFileSync(join(projectDir, "timeline.json"), JSON.stringify(doc), "utf-8");
}

/** 写最小主题快照。 */
function writeThemeSnapshot(): void {
  const snapshot = {
    version: "1",
    themeId: "documentary-dark",
    resolvedAt: "2026-11-07T00:00:00.000Z",
    theme: {
      id: "documentary-dark",
      name: "纪录深色",
      frame: { width: 1920, height: 1080, safe_area: 0.06 },
      tokens: {
        text: "#EAECEF",
        background: "#101216",
        accent: "#E4B95B",
        secondary: [],
        font_family: "Noto Sans SC",
        title_size: 72,
        body_size: 40,
        caption: { size: 36, stroke: 0, bottom_ratio: 0.08, max_chars_per_line: 18 },
      },
      motion: { min_duration_ms: 300, max_duration_ms: 800 },
    },
  };
  writeFileSync(join(projectDir, "theme.resolved.json"), JSON.stringify(snapshot), "utf-8");
}

/** 写最小 SceneSpec（可选）。 */
function writeSceneSpec(): void {
  const spec = {
    contractVersion: "2.0",
    themeId: "documentary-dark",
    shots: [
      {
        shotId: "sh-002",
        visualType: "component",
        componentId: "keyword-block",
        props: { title: "光也无法逃逸" },
        assetRefs: [],
        transition: { in: "hard-cut", out: "hard-cut" },
        animations: [],
      },
    ],
  };
  mkdirSync(join(projectDir, "scenes"), { recursive: true });
  writeFileSync(join(projectDir, "scenes", "spec.json"), JSON.stringify(spec), "utf-8");
}

describe("prepareShotRenderInput", () => {
  test("产物齐备：timeline/theme/spec/imageByShot 全部装配正确", () => {
    writeCopyV2("images/sh-001.png");
    writeTimelineV2();
    writeThemeSnapshot();
    writeSceneSpec();
    mkdirSync(join(projectDir, "images"), { recursive: true });
    writeFileSync(join(projectDir, "images", "sh-001.png"), "png", "utf-8");

    const input = prepareShotRenderInput(projectDir);

    expect(input.timeline.shots.map((shot) => shot.shotId)).toEqual(["sh-001", "sh-002"]);
    expect(input.timeline.fps).toBe(30);
    expect(input.theme.id).toBe("documentary-dark");
    expect(input.specShots.map((shot) => shot.shotId)).toEqual(["sh-002"]);
    // imagePath → publicDir 内相对路径（去掉 images/ 前缀）
    expect(input.imageByShot).toEqual({ "sh-001": "sh-001.png" });
    expect(input.imagesDir).toBe(join(projectDir, "images"));
  });

  test("imagePath 指向不存在的文件：该镜头不进入映射，不报错", () => {
    writeCopyV2("images/sh-001.png");
    writeTimelineV2();
    writeThemeSnapshot();

    const input = prepareShotRenderInput(projectDir);

    expect(input.imageByShot).toEqual({});
  });

  test("imagePath 逃出 images/（如 audio/）：跳过该映射", () => {
    writeCopyV2("audio/sh-001.mp3");
    writeTimelineV2();
    writeThemeSnapshot();
    mkdirSync(join(projectDir, "audio"), { recursive: true });
    writeFileSync(join(projectDir, "audio", "sh-001.mp3"), "mp3", "utf-8");

    const input = prepareShotRenderInput(projectDir);

    expect(input.imageByShot).toEqual({});
  });

  test("imagePath 逃出项目目录（../）：拒绝并报 PATH_OUTSIDE_STORAGE", () => {
    writeCopyV2("../outside.png");
    writeTimelineV2();
    writeThemeSnapshot();

    expect(() => prepareShotRenderInput(projectDir)).toThrowError(/PATH_OUTSIDE_STORAGE|escapes/);
  });

  test("copy 为 v1：报 ADAPTER_PROTOCOL_INVALID", () => {
    writeFileSync(
      join(projectDir, "copy.json"),
      JSON.stringify({
        topic: "黑洞",
        style: "科普",
        title: "黑洞简介",
        scenes: [{ sceneId: "s1", title: "开篇", narration: "n", imagePrompt: "p" }],
      }),
      "utf-8",
    );
    writeTimelineV2();
    writeThemeSnapshot();

    expect(() => prepareShotRenderInput(projectDir)).toThrowError(/v2/);
  });

  test("缺主题快照：报 CONFIG_INVALID", () => {
    writeCopyV2("images/sh-001.png");
    writeTimelineV2();

    expect(() => prepareShotRenderInput(projectDir)).toThrowError(/theme\.resolved\.json/);
  });

  test("scene 未跑：specShots 为空数组，其余正常装配", () => {
    writeCopyV2("images/sh-001.png");
    writeTimelineV2();
    writeThemeSnapshot();

    const input = prepareShotRenderInput(projectDir);

    expect(input.specShots).toEqual([]);
    expect(input.timeline.shots).toHaveLength(2);
  });
});
