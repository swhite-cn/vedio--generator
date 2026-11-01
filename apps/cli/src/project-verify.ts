import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { VideoForgeError, type Actor, type CapabilityDeclaration } from "@videoforge/shared";
import { assertInsideUserRoot, loadSystemConfig, probeDurationMs } from "@videoforge/pipeline";
import { createDatabase } from "@videoforge/server/src/db/index.js";
import { adminListProjects } from "@videoforge/server/src/db/repositories/project-repository.js";
import { getCapability } from "@videoforge/server/src/workflow/capabilities.js";
import { verifyStageArtifact } from "@videoforge/server/src/workflow/breakpoint.js";
import { resolveUserProjectDir } from "@videoforge/server/src/domain/storage-layout.js";
import { requireFlag } from "./args.js";

/** 单阶段产物体检结果。 */
export interface StageCheck {
  stage: string;
  ok: boolean;
}

/** 成片时长一致性判定结果；任一侧缺失时对应字段为 null。 */
export interface VerifyFinalCheck {
  exists: boolean;
  timelineMs: number | null;
  videoMs: number | null;
  deltaMs: number | null;
  consistent: boolean | null;
}

/** `project:verify` 的体检报告。 */
export interface VerifyReport {
  project: string;
  projectDir: string;
  profile: string;
  stages: StageCheck[];
  final: VerifyFinalCheck | null;
  /** 所有阶段达标且（若有成片）时长一致。 */
  ok: boolean;
  hints: string[];
}

/**
 * 成片时长容差（毫秒）。timeline 已含 500ms 尾部停顿，且帧量化/编码取整会引入小幅偏差，
 * 故允许 ±1500ms 的合理区间。
 */
export const TIMELINE_TOLERANCE_MS = 1500;

/** CLI 本机运维通道固定使用的 admin 主体（仓储 `admin*` 方法只校验 `role === 'admin'`）。 */
const CLI_ADMIN_ACTOR: Actor = { userId: "cli", role: "admin" };

/**
 * 只读体检：按能力声明的阶段判据检查产物齐全性，并比对 `timeline.json` 与成片实测时长。
 * 不修改任何文件；`probe` 抛错时仅降级提示，不影响其余检查。
 * @param options.projectDir 项目工作区根目录（绝对路径）
 * @param options.declaration 能力声明（提供阶段判据与成片文件相对路径）
 * @param options.profile 输出 Profile 名（用于替换 glob 中的 `<profile>`）
 * @param options.ffprobePath ffprobe 可执行文件
 * @param options.probe 时长探针（默认 `probeDurationMs`；测试可注入）
 * @returns 体检报告
 */
export async function verifyProjectArtifacts(options: {
  projectDir: string;
  declaration: CapabilityDeclaration;
  profile: string;
  ffprobePath: string;
  probe?: (ffprobePath: string, mediaPath: string) => Promise<number>;
}): Promise<VerifyReport> {
  const probe = options.probe ?? probeDurationMs;
  const hints: string[] = [];

  const stages: StageCheck[] = options.declaration.stages.map((stage) => ({
    stage: stage.stage,
    ok: verifyStageArtifact(options.projectDir, stage.artifact, options.profile),
  }));
  for (const check of stages) {
    if (!check.ok) hints.push(`阶段 ${check.stage} 产物缺失或不合契约`);
  }

  const finalArtifact = options.declaration.finalArtifact;
  const finalExists = verifyStageArtifact(
    options.projectDir,
    { kind: "file", relativePath: finalArtifact },
    options.profile,
  );

  // timeline.json：仅当存在且能解析出数字 totalMs 时参与一致性判定
  let timelineMs: number | null = null;
  const timelinePath = resolve(options.projectDir, "timeline.json");
  assertInsideUserRoot(options.projectDir, timelinePath);
  if (existsSync(timelinePath)) {
    try {
      const doc = JSON.parse(readFileSync(timelinePath, "utf-8")) as { totalMs?: unknown };
      if (typeof doc?.totalMs === "number") timelineMs = doc.totalMs;
    } catch (error) {
      hints.push(`timeline.json 无法解析：${(error as Error).message}`);
    }
  }

  const finalPath = resolve(options.projectDir, finalArtifact);
  assertInsideUserRoot(options.projectDir, finalPath);

  let final: VerifyFinalCheck;
  if (finalExists && timelineMs !== null) {
    try {
      const videoMs = await probe(options.ffprobePath, finalPath);
      const deltaMs = videoMs - timelineMs;
      final = {
        exists: true,
        timelineMs,
        videoMs,
        deltaMs,
        consistent: Math.abs(deltaMs) <= TIMELINE_TOLERANCE_MS,
      };
    } catch (error) {
      hints.push(`ffprobe 无法读取成片时长：${(error as Error).message}`);
      final = { exists: true, timelineMs, videoMs: null, deltaMs: null, consistent: null };
    }
  } else {
    // 任一侧缺失：对应字段为 null，consistent 为 null（成片不存在属正常中间态）
    final = { exists: finalExists, timelineMs, videoMs: null, deltaMs: null, consistent: null };
  }

  if (final.consistent === false && final.deltaMs !== null) {
    hints.push(`成片时长与 timeline 偏差 ${final.deltaMs}ms，超出容差 ±${TIMELINE_TOLERANCE_MS}ms`);
  }

  const ok = stages.every((check) => check.ok) && (final === null || final.consistent !== false);

  return {
    project: basename(options.projectDir),
    projectDir: options.projectDir,
    profile: options.profile,
    stages,
    final,
    ok,
    hints,
  };
}

/**
 * `project:verify`：解析项目 → 只读体检 → stdout 输出一行 JSON（见设计文档 §3.5）。
 * @param rootDir 仓库根目录
 * @param flags 解析后的标志表：`project`（必需）
 * @param deps 可注入依赖；`deps.db` 提供时使用该连接且不关闭（测试用），否则自建连接
 * @throws VideoForgeError(`CONFIG_INVALID`) 缺参数、库未初始化、项目不存在/同名多命中、能力未知
 */
export async function runProjectVerify(
  rootDir: string,
  flags: Record<string, string>,
  deps: { db?: any } = {},
): Promise<void> {
  const projectName = requireFlag(flags, "project");
  const config = loadSystemConfig({ rootDir });

  let db = deps.db;
  let sqlite: { close: () => void } | undefined;
  if (!db) {
    const dbPath = resolve(config.runtime.storage_root, "videoforge.db");
    if (!existsSync(dbPath)) {
      throw new VideoForgeError("CONFIG_INVALID", "数据库尚未初始化，请先执行 db:migrate");
    }
    const connection = createDatabase(dbPath);
    db = connection.db;
    sqlite = connection.sqlite;
  }

  try {
    const matches = adminListProjects(db, CLI_ADMIN_ACTOR).filter(
      (project) => project.name === projectName,
    );
    if (matches.length === 0) {
      throw new VideoForgeError("CONFIG_INVALID", `项目不存在：${projectName}`);
    }
    if (matches.length > 1) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `存在 ${matches.length} 个同名项目（分属不同用户），请先人工确认后再体检`,
      );
    }
    const project = matches[0];
    const declaration = getCapability(project.capability_id);
    if (!declaration) {
      throw new VideoForgeError("CONFIG_INVALID", `未知能力：${project.capability_id}`);
    }
    const projectDir = resolveUserProjectDir(
      config.runtime.storage_root,
      project.user_id,
      project.name,
    );
    const report = await verifyProjectArtifacts({
      projectDir,
      declaration,
      profile: project.profile,
      ffprobePath: config.tools.ffprobe_path,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    sqlite?.close();
  }
}
