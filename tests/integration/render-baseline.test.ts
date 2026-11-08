import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSystemConfig } from "../../packages/pipeline/src/config";
import { loadTheme } from "../../packages/pipeline/src/theme";
import { renderShots } from "../../packages/remotion-engine/src/render";
import {
  timelineDocV2Schema,
  type CueV2,
  type TimelineDocV2,
} from "../../packages/shared/src/index";
import {
  assembleComponentShot,
  getProfile,
  readComponentPreviewFixture,
} from "../../packages/template-sdk/src/index";

/**
 * 渲染性能基线（T210/T503，方案 §11.3；VF_BENCH=1 时运行，真机 Chrome + Remotion）。
 *
 * 样例：13 场景 × 6 镜头 = 78 镜头、每镜 3730ms（总 290,940ms ≈ 4:51）、98 条旁白 cue，
 * 7 类组件轮换（复用预览 fixture props），documentary-dark 主题，LANDSCAPE_1080P @30fps。
 *
 * 测量（只记录，不做性能断言，不承诺更快）：
 * 1. v2Full          —— renderShots 全量 78 镜（concurrency=4），记录耗时/帧数/帧率；
 * 2. v2Concurrency   —— 前 4 镜子集在 concurrency 1/2/4/6 下的耗时曲线（每档独立 bundle）；
 * 3. v2Regen         —— 单镜重渲（T115 镜头级重渲场景），与全量均摊单镜耗时对比得帧复用收益。
 *
 * 帧数口径：durationMs × fps / 1000 向下取整（remotion-engine frames.ts 同式），
 * 3730ms×30fps → 111 帧/镜 → 8658 帧。
 *
 * 运行方式：`pnpm test:bench`（= VF_SMOKE=1 + VF_BENCH=1 定向运行本文件）；
 * 找不到本机 Chrome 时整体跳过。结果 JSON 落盘 docs/v2_refactoring/baselines/render-baseline.json。
 */

/** 每镜头时长毫秒（78 × 3730 = 290,940ms ≈ 4:51）。 */
const SHOT_MS = 3730;
/** 场景数（每场景 6 镜头）。 */
const SCENE_COUNT = 13;
/** 每场景镜头数。 */
const SHOTS_PER_SCENE = 6;
/** 总镜头数（方案样例统计：78 镜头）。 */
const SHOT_COUNT = SCENE_COUNT * SHOTS_PER_SCENE;
/** 旁白 cue 总数（方案样例统计：98 cues）。 */
const CUE_COUNT = 98;
/** v2 全量渲染并发（Remotion 同时渲染的 page 数）。 */
const V2_FULL_CONCURRENCY = 4;
/** 并发曲线档位。 */
const CONCURRENCY_STEPS = [1, 2, 4, 6];
/** 并发曲线使用的镜头数（前 N 镜，444 帧/档）。 */
const CONCURRENCY_SUBSET_SHOTS = 4;
/** 7 类组件 ID（预览 fixture 顺序轮换）。 */
const COMPONENT_IDS = [
  "keyword-block",
  "data-card",
  "quote-card",
  "comparison-bars",
  "progress-ring",
  "chapter-badge",
  "source-tag",
] as const;

const rootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const profileSpec = getProfile("LANDSCAPE_1080P");
const fps = profileSpec.fps;
/** v2 帧数口径：durationMs × fps / 1000 向下取整（remotion-engine frames.ts 同式）。 */
const v2FramesPerShot = Math.max(1, Math.floor((SHOT_MS * fps) / 1000));

/** 探测本机 Chromium：优先仓库配置，其次常见安装路径；找不到返回 undefined（测试跳过）。 */
function detectChromium(): string | undefined {
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

const chromiumPath = detectChromium();

/** 计时辅助：执行异步函数并返回墙钟耗时毫秒。 */
async function timed(fn: () => Promise<void>): Promise<number> {
  const startedAt = Date.now();
  await fn();
  return Date.now() - startedAt;
}

/**
 * 构造 v2 时间轴样例：78 镜连续切点 + 98 条旁白 cue。
 * 前 20 镜每镜 2 条 cue（镜内均分）、其余 58 镜各 1 条，合计 20×2+58=98。
 */
function buildTimelineV2(): TimelineDocV2 {
  const shots = Array.from({ length: SHOT_COUNT }, (_, index) => ({
    shotId: `sh-${String(index + 1).padStart(3, "0")}`,
    sceneId: `s${String(Math.floor(index / SHOTS_PER_SCENE) + 1).padStart(2, "0")}`,
    startMs: index * SHOT_MS,
    endMs: (index + 1) * SHOT_MS,
    durationMs: SHOT_MS,
  }));
  const cues: CueV2[] = [];
  let cueIndex = 0;
  for (const shot of shots) {
    const cueCountForShot = shot.shotId <= "sh-020" ? 2 : 1;
    for (let part = 0; part < cueCountForShot; part += 1) {
      cueIndex += 1;
      const startMs = shot.startMs + Math.floor((SHOT_MS * part) / cueCountForShot);
      const endMs = shot.startMs + Math.floor((SHOT_MS * (part + 1)) / cueCountForShot);
      cues.push({
        cueId: `c-${String(cueIndex).padStart(3, "0")}`,
        shotId: shot.shotId,
        kind: "narration",
        startMs,
        endMs,
        text: `基线样例口播第 ${cueIndex} 句。`,
      });
    }
  }
  const timeline: TimelineDocV2 = {
    contractVersion: "2.0",
    fps,
    tailPauseMs: 0,
    timingSource: "estimated",
    totalMs: SHOT_COUNT * SHOT_MS,
    shots,
    cues,
  };
  // 契约自检：非法样例不应流入测量
  return timelineDocV2Schema.parse(timeline);
}

/** 构造 78 个组件镜头的 SceneSpec（7 类组件轮换，复用各类预览 fixture props）。 */
function buildSpecShots() {
  const fixtures = COMPONENT_IDS.map((componentId) =>
    readComponentPreviewFixture(rootDir, componentId),
  );
  return Array.from({ length: SHOT_COUNT }, (_, index) =>
    assembleComponentShot({
      shotId: `sh-${String(index + 1).padStart(3, "0")}`,
      componentId: fixtures[index % fixtures.length]!.componentId,
      props: fixtures[index % fixtures.length]!.props,
    }),
  );
}

/** 统计目录内 jpeg 帧数。 */
function countJpegs(dir: string): number {
  return readdirSync(dir).filter((name) => name.endsWith(".jpeg")).length;
}

/** 收集运行环境信息（记录并发与耗时数据的解读上下文）。 */
function runtimeInfo() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

describe.skipIf(!chromiumPath || process.env.VF_BENCH !== "1")("渲染性能基线（T210/T503）", () => {
  let workDir = "";
  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "78 镜样例：v2 全量/并发曲线/单镜重渲，结果落盘 JSON",
    { timeout: 2_700_000 },
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "vf-baseline-"));
      const timeline = buildTimelineV2();
      const specShots = buildSpecShots();
      const theme = loadTheme({ rootDir, themeId: "documentary-dark" });
      const entryPoint = join(rootDir, "packages", "remotion-engine", "src", "entry.tsx");
      const outputDir = join(workDir, "render");

      // 1) v2 全量：concurrency=4，bundle 一次
      const v2FullElapsedMs = await timed(async () => {
        await renderShots({
          entryPoint,
          timeline,
          theme,
          specShots,
          outputDir,
          concurrency: V2_FULL_CONCURRENCY,
          browserExecutable: chromiumPath,
        });
      });

      // 2) 单镜重渲（帧复用收益）：只渲 sh-001
      const regenOutputDir = join(workDir, "regen");
      const v2RegenElapsedMs = await timed(async () => {
        await renderShots({
          entryPoint,
          timeline,
          theme,
          specShots,
          shotIds: ["sh-001"],
          outputDir: regenOutputDir,
          concurrency: V2_FULL_CONCURRENCY,
          browserExecutable: chromiumPath,
        });
      });

      // 3) 并发曲线：前 4 镜（444 帧/档），每档独立 bundle
      const subsetShots = timeline.shots.slice(0, CONCURRENCY_SUBSET_SHOTS);
      const subsetTotalMs = subsetShots.reduce((sum, shot) => sum + shot.durationMs, 0);
      const concurrencyRuns = [];
      for (const concurrency of CONCURRENCY_STEPS) {
        const outputDirStep = join(workDir, `concurrency-${concurrency}`);
        const elapsedMs = await timed(async () => {
          await renderShots({
            entryPoint,
            timeline: { ...timeline, shots: subsetShots, totalMs: subsetTotalMs },
            theme,
            specShots,
            outputDir: outputDirStep,
            concurrency,
            browserExecutable: chromiumPath,
          });
        });
        concurrencyRuns.push({
          concurrency,
          totalFrames: subsetShots.length * v2FramesPerShot,
          elapsedMs,
          framesPerSec: Math.round((subsetShots.length * v2FramesPerShot) / (elapsedMs / 1000)),
        });
      }

      // 汇总与派生指标（只呈现，不做"更快"承诺）
      const v2TotalFrames = SHOT_COUNT * v2FramesPerShot;
      const v2AvgMsPerShotFull = Math.round(v2FullElapsedMs / SHOT_COUNT);
      const report = {
        generatedAt: new Date().toISOString(),
        runtime: runtimeInfo(),
        sample: {
          shotCount: SHOT_COUNT,
          sceneCount: SCENE_COUNT,
          cueCount: CUE_COUNT,
          shotMs: SHOT_MS,
          totalMs: SHOT_COUNT * SHOT_MS,
          fps,
          profile: "LANDSCAPE_1080P",
          composition: "v2：7 类组件轮换（复用预览 fixture props，无 image/symbol 镜头）",
        },
        measurements: {
          v2Full: {
            concurrency: V2_FULL_CONCURRENCY,
            totalFrames: v2TotalFrames,
            framesPerShot: v2FramesPerShot,
            elapsedMs: v2FullElapsedMs,
            framesPerSec: Math.round(v2TotalFrames / (v2FullElapsedMs / 1000)),
            note: "含一次 bundle（Remotion webpack 编译）",
          },
          v2Regen: {
            shotIds: ["sh-001"],
            totalFrames: v2FramesPerShot,
            elapsedMs: v2RegenElapsedMs,
            note: "单镜重渲（含一次 bundle）；对比 v2AvgMsPerShotFull 得帧复用收益",
          },
          v2Concurrency: {
            shots: CONCURRENCY_SUBSET_SHOTS,
            note: "每档独立 bundle，帧率含 bundle 开销，看相对趋势而非绝对值",
            runs: concurrencyRuns,
          },
        },
        derived: {
          v2AvgMsPerShotFull,
          regenSpeedupVsFullAvg:
            Math.round((v2AvgMsPerShotFull / Math.max(1, v2RegenElapsedMs)) * 100) / 100,
        },
      };

      // 落盘基线 JSON（docs 下可审计、复跑覆盖）
      const baselineDir = join(rootDir, "docs", "v2_refactoring", "baselines");
      mkdirSync(baselineDir, { recursive: true });
      const baselinePath = join(baselineDir, "render-baseline.json");
      writeFileSync(baselinePath, JSON.stringify(report, null, 2), "utf-8");

      // 结构断言（不做性能断言）：帧数口径与产物齐备
      expect(v2TotalFrames).toBe(8658);
      expect(countJpegs(join(outputDir, "sh-001"))).toBe(v2FramesPerShot);
      expect(countJpegs(join(outputDir, `sh-${String(SHOT_COUNT).padStart(3, "0")}`))).toBe(
        v2FramesPerShot,
      );
      expect(countJpegs(join(regenOutputDir, "sh-001"))).toBe(v2FramesPerShot);
      for (const run of concurrencyRuns) {
        expect(run.totalFrames).toBe(CONCURRENCY_SUBSET_SHOTS * v2FramesPerShot);
      }
      expect(existsSync(baselinePath)).toBe(true);
      expect(report.measurements.v2Full.elapsedMs).toBeGreaterThan(0);
    },
  );
});
