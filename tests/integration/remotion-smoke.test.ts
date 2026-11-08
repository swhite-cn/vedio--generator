import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSystemConfig } from "../../packages/pipeline/src/config";
import { loadTheme } from "../../packages/pipeline/src/theme";
import {
  assembleComponentShot,
  readComponentPreviewFixture,
} from "../../packages/template-sdk/src/index";
import {
  renderShotStill,
  renderShots,
} from "../../packages/remotion-engine/src/render";

/**
 * Remotion 出帧冒烟测试（VF_SMOKE=1 时运行）。
 * 用组件预览 fixture 驱动真实 bundle + 本机 Chrome，验证"契约可出帧"全路径：
 * entry.tsx → bundle → composition 解析 → renderStill / renderFrames。
 * 找不到本机 Chrome 时整体跳过（与 smoke-pipeline 同口径）。
 */

/** 探测本机 Chromium：优先仓库配置，其次常见安装路径；找不到返回 undefined（测试跳过）。 */
function detectChromium(rootDir: string): string | undefined {
  try {
    const configured = loadSystemConfig({ rootDir }).tools.chromium_path;
    if (configured && existsSync(configured)) return configured;
  } catch {
    // 配置不可用时继续探测常见路径
  }
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  return candidates.find((p) => existsSync(p));
}

const rootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const chromiumPath = detectChromium(rootDir);
const entryPoint = join(rootDir, "packages", "remotion-engine", "src", "entry.tsx");

/** 用 keyword-block 预览 fixture 构造渲染输入（主题来自 config/themes，走 schema 校验）。 */
function buildFixtureInput() {
  const fixture = readComponentPreviewFixture(rootDir, "keyword-block");
  const spec = assembleComponentShot({
    shotId: "sh-001",
    componentId: fixture.componentId,
    props: fixture.props,
  });
  const theme = loadTheme({ rootDir, themeId: "documentary-dark" });
  const timeline = {
    contractVersion: "2.0" as const,
    fps: 30,
    tailPauseMs: 0,
    timingSource: "estimated" as const,
    totalMs: 300,
    shots: [
      { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 300, durationMs: 300 },
    ],
    cues: [],
  };
  return { spec, timeline, theme };
}

describe.skipIf(!chromiumPath)("Remotion 出帧冒烟（keyword-block fixture）", () => {
  let workDir = "";
  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "renderShotStill 用 fixture 出单帧 PNG",
    { timeout: 120_000 },
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "vf-remotion-"));
      const { spec, timeline, theme } = buildFixtureInput();
      const output = join(workDir, "still.png");
      await renderShotStill({
        entryPoint,
        timeline,
        theme,
        specShots: [spec],
        shotId: "sh-001",
        output,
        browserExecutable: chromiumPath,
      });
      expect(existsSync(output)).toBe(true);
      // PNG 魔数校验
      const header = readFileSync(output).subarray(0, 8);
      expect(header[0]).toBe(0x89);
      expect(header.subarray(1, 4).toString("ascii")).toBe("PNG");
    },
  );

  it(
    "renderShots 按镜头输出连续帧序列（3 帧 jpeg）",
    { timeout: 120_000 },
    async () => {
      workDir = workDir || mkdtempSync(join(tmpdir(), "vf-remotion-"));
      const { spec, theme } = buildFixtureInput();
      const outputDir = join(workDir, "frames");
      const result = await renderShots({
        entryPoint,
        timeline: {
          contractVersion: "2.0",
          fps: 30,
          tailPauseMs: 0,
          timingSource: "estimated",
          totalMs: 100,
          shots: [
            { shotId: "sh-001", sceneId: "s1", startMs: 0, endMs: 100, durationMs: 100 },
          ],
          cues: [],
        },
        theme,
        specShots: [spec],
        outputDir,
        browserExecutable: chromiumPath,
        concurrency: 1,
      });
      expect(result.totalFrames).toBe(3);
      const shotDir = join(outputDir, "sh-001");
      expect(existsSync(shotDir)).toBe(true);
      // 目录内应有 3 个 .jpeg 文件（remotion 命名 element-N.jpeg）
      const entries = readdirSync(shotDir);
      expect(entries.filter((name) => name.endsWith(".jpeg"))).toHaveLength(3);
    },
  );

  it(
    "七组件 fixture 一次 bundle 出帧（每类 1 镜头）",
    { timeout: 180_000 },
    async () => {
      workDir = workDir || mkdtempSync(join(tmpdir(), "vf-remotion-"));
      const theme = loadTheme({ rootDir, themeId: "documentary-dark" });
      const componentIds = [
        "keyword-block",
        "data-card",
        "quote-card",
        "comparison-bars",
        "progress-ring",
        "chapter-badge",
        "source-tag",
      ] as const;
      const specs = componentIds.map((componentId, index) => {
        const fixture = readComponentPreviewFixture(rootDir, componentId);
        return assembleComponentShot({
          shotId: `sh-00${index + 1}`,
          componentId: fixture.componentId,
          props: fixture.props,
        });
      });
      const outputDir = join(workDir, "all-components");
      const result = await renderShots({
        entryPoint,
        timeline: {
          contractVersion: "2.0",
          fps: 30,
          tailPauseMs: 0,
          timingSource: "estimated",
          totalMs: 700,
          shots: componentIds.map((_, index) => ({
            shotId: `sh-00${index + 1}`,
            sceneId: "s1",
            startMs: index * 100,
            endMs: (index + 1) * 100,
            durationMs: 100,
          })),
          cues: [],
        },
        theme,
        specShots: specs,
        outputDir,
        browserExecutable: chromiumPath,
        concurrency: 1,
      });
      // 每镜头 100ms @30fps = 3 帧，7 镜头共 21 帧
      expect(result.totalFrames).toBe(21);
      for (const shotId of componentIds.map((_, index) => `sh-00${index + 1}`)) {
        const entries = readdirSync(join(outputDir, shotId));
        expect(entries.filter((name) => name.endsWith(".jpeg"))).toHaveLength(3);
      }
    },
  );
});
