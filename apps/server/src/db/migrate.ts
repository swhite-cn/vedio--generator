import { sql } from "drizzle-orm";
import { createDatabase } from "./client.js";

// 迁移语句集（见设计文档 §10.1、§11）。执行顺序：
//   1) 清理已废弃的旧 Build/Voice 领域表（同名 `projects` 直接同名替换，不沿用旧数据）
//   2) 新建新领域 8 张表与索引
const statements = [
  // --- 1) 删除已废弃的旧领域表（见设计文档 §10.1） ---
  // 注意：`projects` 已是新领域表，**不得**在每次启动时 DROP（会导致用户项目丢失）。
  // 旧 Build 领域的 `projects` 已在重构迁移中完成同名替换，此处不再重复删除。
  `DROP TABLE IF EXISTS content_versions`,
  `DROP TABLE IF EXISTS artifacts`,
  `DROP TABLE IF EXISTS quality_results`,
  `DROP TABLE IF EXISTS reviews`,
  `DROP TABLE IF EXISTS metric_snapshots`,
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
  `CREATE TABLE IF NOT EXISTS project_assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, run_id TEXT, stage TEXT, supersedes_asset_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS message_asset_refs (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, asset_id TEXT NOT NULL, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT NOT NULL, run_id TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // `trigger` 是 SQLite 保留字，DDL 中必须加引号；drizzle 查询侧会自动加引号
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, "trigger" TEXT NOT NULL, current_stage TEXT, error_code TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS run_stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT, artifact_paths TEXT NOT NULL DEFAULT '[]', started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, stage_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, ok INTEGER NOT NULL, error_code TEXT, duration_ms INTEGER NOT NULL, artifact_paths TEXT NOT NULL DEFAULT '[]', output_preview TEXT, output_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS llm_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, stage_id TEXT, model TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL)`,

  // --- 2.1) 唯一索引与查询索引 ---
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name ON projects (user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_assets_project_created ON project_assets (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_project_assets_run ON project_assets (run_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_assets_path ON project_assets (project_id, relative_path)`,
  `CREATE INDEX IF NOT EXISTS idx_message_asset_refs_message ON message_asset_refs (message_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_asset_refs_message_asset ON message_asset_refs (message_id, asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_actions_message ON agent_actions (message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_actions_project ON agent_actions (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_run_stages_run ON run_stages (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls (run_id)`,
];

/**
 * 幂等补列：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，故先查 `PRAGMA table_info` 再 ALTER。
 * 用于给既有数据库追加新列而不丢失数据。
 * @param db Drizzle 实例
 * @param sqlite 底层连接
 * @param table 表名
 * @param column 列名
 * @param definition 列定义（不含列名）
 */
function ensureColumn(
  db: any,
  sqlite: any,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  console.info(`[db] migration added column ${table}.${column}`);
}

/**
 * 一次性清理旧 Build 领域的 `projects` 表。
 *
 * 新领域 `projects` 以 `user_id` 为首要归属列；旧表没有该列，无法通过 `CREATE TABLE IF NOT EXISTS`
 * 升级。仅当「表存在且缺少 `user_id`」时删除一次，避免旧结构阻断索引创建；
 * 已升级的库（含 `user_id`）**绝不删除**，保证用户项目数据不因重启丢失。
 * @param sqlite 底层连接
 */
function dropLegacyProjectsTable(sqlite: any): void {
  const rows = sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (rows.length === 0) return;
  if (rows.some((row) => row.name === "user_id")) return;
  sqlite.exec("DROP TABLE projects");
  console.warn("[db] migration dropped legacy Build-domain projects table (pre-user_id schema)");
}

/**
 * 创建/重建 VideoForge 数据表（幂等：可重复执行）。
 * 单个事务内依次执行 DROP / CREATE / 补列语句；任一句失败即回滚，并打印可读的失败语句便于定位。
 * 迁移**不删除**新领域表，只清理已废弃的旧表，保证用户数据不被重启清空。
 * @param filename SQLite 文件路径（`:memory:` 用于测试）
 */
export function migrateDatabase(filename: string): void {
  const { db, sqlite } = createDatabase(filename);
  const migrate = sqlite.transaction(() => {
    dropLegacyProjectsTable(sqlite);
    for (const statement of statements) {
      try {
        db.run(sql.raw(statement));
      } catch (error) {
        console.error(`[db] migration statement failed: ${statement}`);
        throw error;
      }
    }
    // 追加式补列（既有数据库升级路径）
    ensureColumn(db, sqlite, "tool_calls", "output_preview", "TEXT");
    ensureColumn(db, sqlite, "tool_calls", "output_truncated", "INTEGER NOT NULL DEFAULT 0");
  });
  migrate();
  console.info(`[db] migration completed: ${filename}`);
  sqlite.close();
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrateDatabase(process.argv[3] ?? ":memory:");
}
