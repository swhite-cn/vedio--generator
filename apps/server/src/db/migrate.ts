import { sql } from "drizzle-orm";
import { createDatabase } from "./client.js";

// 迁移语句集（见设计文档 §10.1、§11）。执行顺序：
//   1) 清理已废弃的旧 Build/Voice 领域表（同名 `projects` 直接同名替换，不沿用旧数据）
//   2) 新建新领域 8 张表与索引
const statements = [
  // --- 1) 删除已废弃的旧领域表（见设计文档 §10.1） ---
  `DROP TABLE IF EXISTS content_versions`,
  `DROP TABLE IF EXISTS artifacts`,
  `DROP TABLE IF EXISTS quality_results`,
  `DROP TABLE IF EXISTS reviews`,
  `DROP TABLE IF EXISTS metric_snapshots`,
  // 旧 projects（旧 Build 领域）与新 projects（§11）同名语义不同：同名替换，勿沿用旧数据
  `DROP TABLE IF EXISTS projects`,
  // 旧 Build / Voice 领域表（P12 随旧仓储一并移除）
  `DROP TABLE IF EXISTS builds`,
  `DROP TABLE IF EXISTS tasks`,
  `DROP TABLE IF EXISTS build_events`,
  `DROP TABLE IF EXISTS tts_voices`,
  `DROP TABLE IF EXISTS tts_catalog_state`,
  `DROP TABLE IF EXISTS tts_preview_cache`,

  // --- 2) 新领域 8 张表（字段逐字对齐设计文档 §11） ---
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, capability_id TEXT NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL, style TEXT, profile TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`,
  // `trigger` 是 SQLite 保留字，DDL 中必须加引号；drizzle 查询侧会自动加引号
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, "trigger" TEXT NOT NULL, current_stage TEXT, error_code TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS run_stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT, artifact_paths TEXT NOT NULL DEFAULT '[]', started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, stage_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, ok INTEGER NOT NULL, error_code TEXT, duration_ms INTEGER NOT NULL, artifact_paths TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS llm_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, stage_id TEXT, model TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`,

  // --- 2.1) 唯一索引与查询索引 ---
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name ON projects (user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_run_stages_run ON run_stages (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls (run_id)`,
];

/**
 * 创建/重建 VideoForge 数据表（幂等：可重复执行）。
 * 单个事务内依次执行 DROP / CREATE 语句；任一句失败即回滚，并打印可读的失败语句便于定位。
 * @param filename SQLite 文件路径（`:memory:` 用于测试）
 */
export function migrateDatabase(filename: string): void {
  const { db, sqlite } = createDatabase(filename);
  const migrate = sqlite.transaction(() => {
    for (const statement of statements) {
      try {
        db.run(sql.raw(statement));
      } catch (error) {
        console.error(`[db] migration statement failed: ${statement}`);
        throw error;
      }
    }
  });
  migrate();
  console.info(`[db] migration completed: ${filename}`);
  sqlite.close();
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrateDatabase(process.argv[3] ?? ":memory:");
}
