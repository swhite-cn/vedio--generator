import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunStage } from "@videoforge/shared";
import { PIPELINE_STAGES } from "@videoforge/shared";
import {
  readCopyDocument,
  readTimelineV2,
  TIMELINE_V2_RELATIVE_PATH,
} from "@videoforge/pipeline";

/**
 * 项目派生指标（T116，方案 §7.5）：
 * 前端不推导状态机，以下全部由服务端计算：
 * - `shotCount` / `boundShotCount` 来自 copy v2；
 * - `totalMs` / `averageShotMs` 来自 timeline v2；
 * - `progress` = 已完成阶段权重 + 运行中阶段 0.5；
 * - `etaSeconds` 按本项目历史阶段耗时中位数估算，无历史时为 `null`。
 * v1 项目或产物缺失/非法时，对应字段为 `null`（列表页不因坏文件失败）。
 */

/** 项目派生指标（方案 §7.5）。 */
export interface ProjectMetrics {
  /** copy v2 镜头总数；v1 项目或 copy 缺失时为 `null`。 */
  shotCount: number | null;
  /** timeline v2 总时长（毫秒，含尾停顿）；v1 项目或 timeline 缺失/非法时为 `null`。 */
  totalMs: number | null;
  /** timeline v2 镜头平均时长（毫秒）；无镜头时为 `null`。 */
  averageShotMs: number | null;
  /** 流水线进度 0..1（按运行时能力声明阶段等权；运行中阶段计 0.5）。 */
  progress: number;
  /** 预计剩余秒数（按本项目历史阶段耗时中位数）；无任何历史耗时或无 run 时为 `null`。 */
  etaSeconds: number | null;
  /** copy v2 中绑定过至少一个资产的镜头数；v1 项目或 copy 缺失时为 `null`。 */
  boundShotCount: number | null;
}

/** 派生指标计算输入（路由层负责把 runs/run_stages 查好传入）。 */
export interface ProjectMetricsInput {
  /** 项目工作目录（读 copy.json / timeline.json） */
  projectDir: string;
  /** 该项目全部 run（按创建时间倒序，第一项即最新 run） */
  runs: Run[];
  /** 该项目全部 run 的阶段实例 */
  runStages: RunStage[];
}

/**
 * 读取 copy v2 的镜头总数与绑定镜头数。
 * @param projectDir 项目工作目录
 * @returns 统计结果；v1 项目、文件缺失或结构非法时为 `null`
 */
function readCopyV2Stats(projectDir: string): { shotCount: number; boundShotCount: number } | null {
  const copyPath = join(projectDir, "copy.json");
  if (!existsSync(copyPath)) return null;
  try {
    const document = readCopyDocument(copyPath);
    if (document.version !== "2") return null;
    const boundShots = new Set<string>();
    for (const scene of document.doc.scenes) {
      for (const shot of scene.shots) {
        if (shot.assetRefs.length > 0) boundShots.add(shot.shotId);
      }
    }
    const shotCount = document.doc.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
    return { shotCount, boundShotCount: boundShots.size };
  } catch {
    // copy.json 非法不应让列表页失败；指标降级为 null
    return null;
  }
}

/**
 * 读取 timeline v2 的总时长与镜头平均时长。
 * @param projectDir 项目工作目录
 * @returns 统计结果；文件缺失或结构非法时为 `null`
 */
function readTimelineV2Stats(projectDir: string): { totalMs: number; averageShotMs: number | null } | null {
  const timelinePath = join(projectDir, TIMELINE_V2_RELATIVE_PATH);
  if (!existsSync(timelinePath)) return null;
  try {
    const timeline = readTimelineV2(timelinePath);
    const averageShotMs =
      timeline.shots.length > 0
        ? timeline.shots.reduce((sum, shot) => sum + shot.durationMs, 0) / timeline.shots.length
        : null;
    return { totalMs: timeline.totalMs, averageShotMs };
  } catch {
    // timeline.json 非法（含 v1 场景级时间轴）时降级为 null
    return null;
  }
}

/**
 * 聚合每个阶段的最新一次尝试（入参已按阶段序 + attempt 升序，后条覆盖前条）。
 * @param runStages 阶段实例列表
 * @returns stage → 最新阶段实例
 */
function latestStageAttempts(runStages: RunStage[]): Map<string, RunStage> {
  const latest = new Map<string, RunStage>();
  for (const stage of runStages) {
    latest.set(stage.stage, stage);
  }
  return latest;
}

/**
 * 计算流水线进度（方案 §7.5：已完成阶段权重 + 当前阶段内进度）。
 * 阶段等权：done/skipped 计 1，running 计 0.5（阶段内中点近似），其余计 0；
 * 只统计最新 run 的阶段实例，历史 run 不累计。
 * @param latestRunId 最新 run ID（runs 按创建时间倒序的第一项）；无 run 时为 `undefined`
 * @param runStages 该项目全部 run 的阶段实例
 * @returns 进度 0..1；无任何阶段实例时为 0
 */
export function computeProgress(latestRunId: string | undefined, runStages: RunStage[]): number {
  const latest = latestStageAttempts(
    latestRunId ? runStages.filter((stage) => stage.run_id === latestRunId) : [],
  );
  if (latest.size === 0) return 0;
  const total = latest.size > PIPELINE_STAGES.length ? latest.size : PIPELINE_STAGES.length;
  let weight = 0;
  for (const stage of latest.values()) {
    if (stage.status === "done" || stage.status === "skipped") weight += 1;
    else if (stage.status === "running") weight += 0.5;
  }
  return weight / total;
}

/**
 * 计算一组阶段耗时的中位数（毫秒）。
 * @param durationsMs 耗时样本（非正数已由调用方过滤）
 * @returns 中位数；空数组为 `null`
 */
function median(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 从历史阶段实例收集各阶段成功耗时（毫秒）。
 * @param runStages 该项目全部 run 的阶段实例
 * @returns stage → 耗时样本列表
 */
function collectStageDurations(runStages: RunStage[]): Map<string, number[]> {
  const durations = new Map<string, number[]>();
  for (const stage of runStages) {
    if (stage.status !== "done" || !stage.started_at || !stage.ended_at) continue;
    const elapsed = Date.parse(stage.ended_at) - Date.parse(stage.started_at);
    if (!Number.isFinite(elapsed) || elapsed <= 0) continue;
    const bucket = durations.get(stage.stage) ?? [];
    bucket.push(elapsed);
    durations.set(stage.stage, bucket);
  }
  return durations;
}

/**
 * 估算预计剩余秒数（方案 §7.5：按阶段历史中位数，允许 `null`）。
 * 剩余阶段 = 运行时能力声明中，最新 run 尚未 done/skipped 的阶段；
 * 每个剩余阶段取该项目该阶段历史中位数，缺历史时回退全体样本中位数，无任何样本返回 `null`。
 * @param latestRunId 最新 run ID（runs 按创建时间倒序的第一项）；无 run 时为 `undefined`
 * @param runStages 该项目全部 run 的阶段实例
 * @returns 预计剩余秒数（向上取整）；无样本时为 `null`，run 已全部完成时为 0
 */
export function computeEtaSeconds(
  latestRunId: string | undefined,
  runStages: RunStage[],
): number | null {
  if (!latestRunId || runStages.length === 0) return null;
  const latest = latestStageAttempts(runStages.filter((stage) => stage.run_id === latestRunId));
  const remaining = PIPELINE_STAGES.filter((stage) => {
    const current = latest.get(stage);
    return !current || (current.status !== "done" && current.status !== "skipped");
  });
  const durations = collectStageDurations(runStages);
  const allSamples = [...durations.values()].flat();
  if (remaining.length === 0) return 0;
  if (allSamples.length === 0) return null;

  const fallback = median(allSamples) ?? 0;
  const totalMs = remaining.reduce((sum, stage) => {
    const stageMedian = median(durations.get(stage) ?? []);
    return sum + (stageMedian ?? fallback);
  }, 0);
  return Math.ceil(totalMs / 1000);
}

/**
 * 组装项目派生指标（方案 §7.5）。文件读取失败/非法一律降级为 `null`，不抛错。
 * @param input 项目目录与 run/阶段数据
 * @returns 派生指标
 */
export function deriveProjectMetrics(input: ProjectMetricsInput): ProjectMetrics {
  const copyStats = readCopyV2Stats(input.projectDir);
  const timelineStats = readTimelineV2Stats(input.projectDir);
  const latestRunId = input.runs[0]?.id;
  return {
    shotCount: copyStats?.shotCount ?? null,
    totalMs: timelineStats?.totalMs ?? null,
    averageShotMs: timelineStats?.averageShotMs ?? null,
    progress: computeProgress(latestRunId, input.runStages),
    etaSeconds: computeEtaSeconds(latestRunId, input.runStages),
    boundShotCount: copyStats?.boundShotCount ?? null,
  };
}
