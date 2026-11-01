import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import { assertInsideUserRoot, loadSystemConfig } from "@videoforge/pipeline";
import { createDatabase } from "@videoforge/server/src/db/index.js";
import { adminListProjects } from "@videoforge/server/src/db/repositories/project-repository.js";
import { resolveUserProjectDir } from "@videoforge/server/src/domain/storage-layout.js";
import { requireFlag } from "./args.js";

/**
 * CLI 本机运维通道固定使用的 admin 主体（仓储 `admin*` 方法只校验 `role === 'admin'`）。
 */
const CLI_ADMIN_ACTOR: Actor = { userId: "cli", role: "admin" };

/**
 * 递归统计目录体积（字节）；单个文件/子目录读取失败即忽略，不中断整体统计。
 * @param dir 目录绝对路径
 * @returns 目录内文件字节数合计
 */
function directorySize(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(child);
      } else if (entry.isFile()) {
        total += statSync(child).size;
      }
    } catch {
      // 忽略单个失败项
    }
  }
  return total;
}

/**
 * `storage:prune`：清理项目中间产物（帧序列与临时音轨），保留契约文件与成片。
 * 删除范围仅限 `<projectDir>/build`（含 `build/render/<profile>/frames/*.jpg`、
 * `build/compose/<profile>/` 下的临时音轨与中间件）；**不删除** `copy.json` / `images/` /
 * `scenes/` / `audio/` / `timeline.json` / `final.mp4`。
 *
 * 受控偏差：设计文档写的是位置参数 `storage:prune <项目>`，但仓库现有 `parseArgs` 只解析
 * `--key value`，故改用 `--project <项目>` 标志（见交付报告偏差登记）。
 * @param rootDir 仓库根目录
 * @param flags 解析后的标志表：`project`（必需）、`yes`（必需，显式确认为 true/1）
 * @throws VideoForgeError(`CONFIG_INVALID`) 缺参数、未确认、库未初始化、项目不存在或同名多命中
 */
export async function runStoragePrune(
  rootDir: string,
  flags: Record<string, string>,
): Promise<void> {
  const projectName = requireFlag(flags, "project");
  const confirmed = flags.yes === "true" || flags.yes === "1";
  if (!confirmed) {
    throw new VideoForgeError("CONFIG_INVALID", "清理操作需显式确认：请追加 --yes");
  }

  const config = loadSystemConfig({ rootDir });
  const storageRoot = config.runtime.storage_root;
  const dbPath = resolve(storageRoot, "videoforge.db");
  if (!existsSync(dbPath)) {
    throw new VideoForgeError("CONFIG_INVALID", "数据库尚未初始化，请先执行 db:migrate");
  }

  const { db, sqlite } = createDatabase(dbPath);
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
        `存在 ${matches.length} 个同名项目（分属不同用户），请先人工确认后再清理`,
      );
    }
    const project = matches[0];
    const projectDir = resolveUserProjectDir(storageRoot, project.user_id, project.name);
    const usersRoot = resolve(storageRoot, "users", project.user_id);
    const buildDir = resolve(projectDir, "build");
    // 删除前复核目标仍在用户根目录内（禁止字符串拼接构造敏感路径）
    assertInsideUserRoot(usersRoot, buildDir);

    if (!existsSync(buildDir)) {
      console.info(`[cli] storage:prune: 无需清理（build 目录不存在）：${projectDir}`);
      process.stdout.write(
        `${JSON.stringify({
          project: project.name,
          projectDir,
          removed: null,
          freedBytes: 0,
          freedMb: 0,
        })}\n`,
      );
      return;
    }

    const freedBytes = directorySize(buildDir);
    rmSync(buildDir, { recursive: true, force: true });
    const freedMb = Number((freedBytes / 1024 ** 2).toFixed(2));
    console.info(`[cli] storage:prune: 已清理 ${buildDir}（释放 ${freedMb} MB）`);
    process.stdout.write(
      `${JSON.stringify({
        project: project.name,
        projectDir,
        removed: "build",
        freedBytes,
        freedMb,
      })}\n`,
    );
  } finally {
    sqlite.close();
  }
}
