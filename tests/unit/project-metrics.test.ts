import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Run, RunStage } from "@videoforge/shared";
import {
  parseCopyV2Json,
  writeCopyDocV2,
  writeTimelineV2,
} from "../../packages/pipeline/src/index";
import {
  computeEtaSeconds,
  computeProgress,
  deriveProjectMetrics,
} from "../../apps/server/src/domain/project-metrics";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-metrics-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 构造测试用 run 夹具（字段满足领域类型即可）。 */
function makeRun(id: string, createdAt: string): Run {
  return {
    id,
    project_id: "p1",
    session_id: "s1",
    status: "running",
    trigger: "user",
    current_stage: null,
    error_code: null,
    scope_json: null,
    contract_version: "2.0",
    created_at: createdAt,
    started_at: null,
    ended_at: null,
  };
}

/** 构造测试用阶段实例夹具。 */
function makeStage(
  runId: string,
  stage: RunStage["stage"],
  status: RunStage["status"],
  startedAt: string | null = null,
  endedAt: string | null = null,
): RunStage {
  return {
    id: `${runId}-${stage}`,
    run_id: runId,
    stage,
    status,
    attempt: 0,
    error_code: null,
    artifact_paths: [],
    started_at: startedAt,
    ended_at: endedAt,
  };
}

describe("computeProgress", () => {
  test("无任何阶段实例时进度为 0", () => {
    expect(computeProgress(undefined, [])).toBe(0);
    expect(computeProgress("r1", [])).toBe(0);
  });

  test("done 计 1、running 计 0.5、skipped 计 1，分母为能力声明阶段数", () => {
    const runStages = [
      makeStage("r1", "copy", "done"),
      makeStage("r1", "image", "running"),
      makeStage("r1", "scene", "pending"),
      // 历史 run 的实例不累计
      makeStage("r0", "copy", "done"),
    ];
    // (1 + 0.5) / 8
    expect(computeProgress("r1", runStages)).toBeCloseTo(1.5 / 8, 8);
  });

  test("镜头级重生成的 skipped 前序阶段按完成计", () => {
    const runStages = [
      makeStage("r1", "copy", "skipped"),
      makeStage("r1", "image", "skipped"),
      makeStage("r1", "scene", "skipped"),
      makeStage("r1", "tts", "skipped"),
      makeStage("r1", "captions", "skipped"),
      makeStage("r1", "storyboard", "skipped"),
      makeStage("r1", "render", "running"),
      makeStage("r1", "compose", "pending"),
    ];
    expect(computeProgress("r1", runStages)).toBeCloseTo(6.5 / 8, 8);
  });
});

describe("computeEtaSeconds", () => {
  test("无 run 或无历史耗时样本时为 null", () => {
    expect(computeEtaSeconds(undefined, [])).toBeNull();
    const noSamples = [makeStage("r1", "copy", "running")];
    expect(computeEtaSeconds("r1", noSamples)).toBeNull();
  });

  test("最新 run 全部完成时为 0", () => {
    const runStages = [
      makeStage("r1", "copy", "done", "2026-11-07T10:00:00Z", "2026-11-07T10:00:10Z"),
      makeStage("r1", "image", "done", "2026-11-07T10:00:10Z", "2026-11-07T10:00:30Z"),
    ];
    // remaining 只剩 scene..compose，但有历史样本 → 非 0；全部 done 时才是 0
    const allDone = [...runStages];
    for (const stage of ["scene", "tts", "captions", "storyboard", "render", "compose"] as const) {
      allDone.push(makeStage("r1", stage, "done"));
    }
    expect(computeEtaSeconds("r1", allDone)).toBe(0);
  });

  test("按阶段中位数估算，缺历史阶段回退全体中位数", () => {
    const runStages = [
      // 历史 run：copy 耗时 10s、image 耗时 30s
      makeStage("r0", "copy", "done", "2026-11-07T09:00:00Z", "2026-11-07T09:00:10Z"),
      makeStage("r0", "image", "done", "2026-11-07T09:00:10Z", "2026-11-07T09:00:40Z"),
      // 最新 run：只完成 copy
      makeStage("r1", "copy", "done", "2026-11-07T10:00:00Z", "2026-11-07T10:00:20Z"),
    ];
    // 剩余 7 阶段：image 有样本 [30s]，r1 image 无样本。
    // 实际样本：copy [10s, 20s]、image [30s]；剩余阶段 image → 30s；
    // 其余 6 阶段回退全体中位数 median([10,20,30]) = 20s。
    // totalMs = 30_000 + 6 * 20_000 = 150_000 → 150s
    expect(computeEtaSeconds("r1", runStages)).toBe(150);
  });
});

describe("deriveProjectMetrics", () => {
  test("v1 项目且无 timeline：copy/timeline 类指标为 null，进度为 0", () => {
    const projectDir = join(directory, "v1");
    const metrics = deriveProjectMetrics({ projectDir, runs: [], runStages: [] });
    expect(metrics).toEqual({
      shotCount: null,
      totalMs: null,
      averageShotMs: null,
      progress: 0,
      etaSeconds: null,
      boundShotCount: null,
    });
  });

  test("v2 copy + timeline v2 时返回完整统计", async () => {
    const projectDir = join(directory, "v2");
    const copy = parseCopyV2Json(
      JSON.stringify({
        title: "水银变黄金",
        styleAnchors: [{ key: "mercury", label: "水银", color: "#C9CED6" }],
        scenes: [
          {
            sceneId: "s1",
            chapterNo: 1,
            title: "开场",
            shots: [
              {
                shotId: "sh-001",
                narration: "第一句。",
                visualType: "image",
                assetRefs: [{ assetId: "asset-a", role: "background" }],
              },
              { shotId: "sh-002", narration: "第二句。", visualType: "symbol" },
            ],
          },
        ],
      }),
      { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
    );
    await writeCopyDocV2(join(projectDir, "copy.json"), copy);
    await writeFile(join(projectDir, "timeline.json"), "not-json", "utf-8").catch(() => undefined);
    // 非法 timeline 降级 null；再写合法版本验证正常路径
    const metricsBroken = deriveProjectMetrics({ projectDir, runs: [], runStages: [] });
    expect(metricsBroken.totalMs).toBeNull();
    expect(metricsBroken.shotCount).toBe(2);
    expect(metricsBroken.boundShotCount).toBe(1);

    writeTimelineV2(join(projectDir, "timeline.json"), {
      contractVersion: "2.0",
      fps: 30,
      tailPauseMs: 500,
      timingSource: "estimated",
      totalMs: 6500,
      shots: [
        {
          shotId: "sh-001",
          sceneId: "s1",
          startMs: 0,
          endMs: 3000,
          durationMs: 3000,
        },
        {
          shotId: "sh-002",
          sceneId: "s1",
          startMs: 3000,
          endMs: 6000,
          durationMs: 3000,
        },
      ],
      cues: [],
    });
    const metrics = deriveProjectMetrics({ projectDir, runs: [makeRun("r1", "2026-11-07T10:00:00Z")], runStages: [] });
    expect(metrics).toMatchObject({
      shotCount: 2,
      totalMs: 6500,
      averageShotMs: 3000,
      boundShotCount: 1,
      progress: 0,
      etaSeconds: null,
    });
  });
});
