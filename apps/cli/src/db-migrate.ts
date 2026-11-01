import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadSystemConfig } from "@videoforge/pipeline";
import { migrateDatabase } from "@videoforge/server/src/db/index.js";

/**
 * `db:migrate`：对本机 SQLite 执行幂等迁移，stdout 输出一行 JSON（见设计文档 §3.5）。
 * 迁移前自动创建存储目录，迁移可重复执行。
 * @param rootDir 仓库根目录
 * @param flags 解析后的标志表（本命令不消费任何标志）
 */
export async function runDbMigrate(rootDir: string, flags: Record<string, string>): Promise<void> {
  const config = loadSystemConfig({ rootDir });
  const dbPath = resolve(config.runtime.storage_root, "videoforge.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  migrateDatabase(dbPath);
  console.info(`[cli] db:migrate completed: ${dbPath}`);
  process.stdout.write(`${JSON.stringify({ dbPath, migrated: true })}\n`);
}
