import type { Actor, Run, RunStage } from "@videoforge/shared";
import { getCapability } from "../workflow/capabilities.js";
import { verifyStageArtifact } from "../workflow/breakpoint.js";
import { resolveUserProjectDir } from "../domain/storage-layout.js";
import { getProject } from "../db/repositories/project-repository.js";

/**
 * 运行视图的「产物优先」校正（见设计文档 §8.4：`final.mp4` 是 done 的唯一判据）。
 *
 * 背景：阶段工具也可以被自由对话直接调用（例如修复 TTS 后在聊天里补跑 tts / render / compose），
 * 这类调用只写 `tool_calls`，不推进 `run_stages`，于是会出现「产物齐全、成片存在，
 * 但阶段条仍停留在旧 run 的 failed / pending」。本模块在读取 run 时用文件系统产物做视图校正：
 *
 * - 每个阶段只看该阶段 **attempt 最大** 的那一行（历史失败行保持原样，供 trace 审计）；
 * - 该阶段产物判据在工作区通过时，视图状态记为 `done` 并清空 `error_code`；
 * - 最终产物存在且 run 以 failed 收场时，视图状态记为 `done`（不修改数据库）。
 *
 * 只做视图层校正，不写入 `run_stages`，因此不覆盖任何历史结论。
 */

/** 校正结果。 */
export interface ReconciledRunView {
  run: Run;
  stages: RunStage[];
}

/**
 * 按工作区产物校正 run 与阶段视图。
 * 项目 / 能力 / 目录任一不可解析时原样返回（不阻断接口）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param storageRoot 存储根目录
 * @param run 原始 run
 * @param stages 原始阶段行（同一阶段可能有多条 attempt）
 * @returns 校正后的 run 与阶段行
 */
export function reconcileRunView(
  db: any,
  actor: Actor,
  storageRoot: string,
  run: Run,
  stages: RunStage[],
): ReconciledRunView {
  const project = getProject(db, actor, run.project_id);
  const capability = project ? getCapability(project.capability_id) : undefined;
  if (!project || !capability) {
    return { run, stages };
  }

  let projectDir: string;
  try {
    projectDir = resolveUserProjectDir(storageRoot, actor.userId, project.name);
  } catch {
    return { run, stages };
  }

  // 每个阶段只校正最新一次尝试，历史 attempt 行保留真实结论
  const latestAttempt = new Map<string, number>();
  for (const row of stages) {
    const current = latestAttempt.get(row.stage);
    if (current === undefined || row.attempt > current) {
      latestAttempt.set(row.stage, row.attempt);
    }
  }

  const reconciledStages = stages.map((row) => {
    if (latestAttempt.get(row.stage) !== row.attempt) return row;
    if (row.status === "done") return row;
    const declaration = capability.stages.find((stage) => stage.stage === row.stage);
    if (!declaration) return row;
    let satisfied = false;
    try {
      satisfied = verifyStageArtifact(projectDir, declaration.artifact, project.profile);
    } catch {
      satisfied = false;
    }
    return satisfied ? { ...row, status: "done" as const, error_code: null } : row;
  });

  const finalVideoExists = verifyStageArtifact(
    projectDir,
    { kind: "file", relativePath: capability.finalArtifact },
    project.profile,
  );
  const reconciledRun: Run =
    finalVideoExists && run.status === "failed" ? { ...run, status: "done", error_code: null } : run;

  return { run: reconciledRun, stages: reconciledStages };
}
