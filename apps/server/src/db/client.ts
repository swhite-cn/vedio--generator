import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/**
 * 创建 SQLite/Drizzle 数据库连接。
 * @param filename 数据库文件路径，`:memory:` 用于测试
 * @returns Drizzle 数据库实例及底层连接
 */
export function createDatabase(filename: string): {
  sqlite: InstanceType<typeof Database>;
  db: ReturnType<typeof drizzle>;
} {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  console.info(`[db] opened sqlite database: ${filename}`);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
