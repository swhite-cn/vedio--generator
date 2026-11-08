import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, migrateDatabase } from "../../apps/server/src/db";

/** 新领域 8 张表（见设计文档 §11）。 */
const NEW_TABLES = [
  "users",
  "projects",
  "sessions",
  "messages",
  "runs",
  "run_stages",
  "tool_calls",
  "llm_calls",
];

/** 已在 P12 删除的旧 Build/Voice 表。 */
const REMOVED_TABLES = [
  "content_versions",
  "artifacts",
  "quality_results",
  "reviews",
  "metric_snapshots",
  "builds",
  "tasks",
  "build_events",
  "tts_voices",
  "tts_catalog_state",
  "tts_preview_cache",
];

let directory: string;
let filename: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-schema-"));
  filename = join(directory, "videoforge.db");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 列出库中所有普通表名（排除 sqlite 内部表）。 */
function listTables(database: ReturnType<typeof createDatabase>): string[] {
  const rows = database.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

/** 列出库中所有索引名。 */
function listIndexes(database: ReturnType<typeof createDatabase>): string[] {
  const rows = database.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

/** 读取某表的列名。 */
function listColumns(database: ReturnType<typeof createDatabase>, table: string): string[] {
  const rows = database.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

describe("数据库 schema 重建", () => {
  test("迁移后新建 8 张新领域表", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      const tables = listTables(database);
      for (const table of NEW_TABLES) expect(tables).toContain(table);
    } finally {
      database.sqlite.close();
    }
  });

  test("旧 Build/Voice 领域表全部被删除", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      const tables = listTables(database);
      for (const table of REMOVED_TABLES) expect(tables).not.toContain(table);
    } finally {
      database.sqlite.close();
    }
  });

  test("users 字段与 §11 逐字对齐", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      expect(listColumns(database, "users")).toEqual([
        "id",
        "username",
        "password_hash",
        "display_name",
        "role",
        "must_change_password",
        "created_at",
        "last_login_at",
      ]);
    } finally {
      database.sqlite.close();
    }
  });

  test("users 与 projects 的唯一索引存在", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      const indexes = listIndexes(database);
      expect(indexes).toContain("idx_users_username");
      expect(indexes).toContain("idx_projects_user_name");
    } finally {
      database.sqlite.close();
    }
  });

  test("迁移可重复执行（幂等）", () => {
    expect(() => migrateDatabase(filename)).not.toThrow();
    expect(() => migrateDatabase(filename)).not.toThrow();
  });

  test("v2 迁移补齐契约/主题/镜头范围/素材分类列", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      expect(listColumns(database, "projects")).toEqual(
        expect.arrayContaining(["theme_id", "contract_version"]),
      );
      expect(listColumns(database, "runs")).toEqual(
        expect.arrayContaining(["scope_json", "contract_version"]),
      );
      expect(listColumns(database, "project_assets")).toContain("visual_category");
    } finally {
      database.sqlite.close();
    }
  });

  test("登录日志表与索引存在", () => {
    migrateDatabase(filename);
    const database = createDatabase(filename);
    try {
      expect(listTables(database)).toContain("login_events");
      expect(listColumns(database, "login_events")).toEqual([
        "id",
        "user_id",
        "username",
        "ok",
        "reason",
        "ip",
        "user_agent",
        "created_at",
      ]);
      const indexes = listIndexes(database);
      expect(indexes).toContain("idx_login_events_created");
      expect(indexes).toContain("idx_login_events_username");
    } finally {
      database.sqlite.close();
    }
  });

  test("既有数据库升级后新增列带默认契约版本", () => {
    // 先按 v1 结构建库并写入一行
    const legacy = createDatabase(filename);
    legacy.sqlite.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, capability_id TEXT NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL, style TEXT, profile TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    legacy.sqlite.exec(
      "INSERT INTO projects (id, user_id, capability_id, name, topic, profile, status, created_at, updated_at) VALUES ('p-old', 'u1', 'cap', '旧项目', '主题', 'landscape-1080p', 'draft', '2026-01-01', '2026-01-01')",
    );
    legacy.sqlite.close();

    migrateDatabase(filename);

    const database = createDatabase(filename);
    try {
      const row = database.sqlite
        .prepare("SELECT contract_version, theme_id FROM projects WHERE id = 'p-old'")
        .get() as { contract_version: string; theme_id: string | null };
      expect(row.contract_version).toBe("1.0");
      expect(row.theme_id).toBeNull();
    } finally {
      database.sqlite.close();
    }
  });

  test("旧 projects（无 user_id）一次性替换：旧数据不沿用，新结构生效", () => {
    // 先造出旧 Build 领域的 projects 表并写入一行
    const legacy = createDatabase(filename);
    legacy.sqlite.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    legacy.sqlite.exec(
      "INSERT INTO projects (id, title, category, created_at) VALUES ('old-1', 't', 'c', '2026-01-01')",
    );
    legacy.sqlite.close();

    migrateDatabase(filename);

    const database = createDatabase(filename);
    try {
      expect(listColumns(database, "projects")).toContain("user_id");
      expect(listColumns(database, "projects")).not.toContain("title");
      const count = database.sqlite.prepare("SELECT COUNT(*) AS c FROM projects").get() as {
        c: number;
      };
      expect(count.c).toBe(0);
    } finally {
      database.sqlite.close();
    }
  });

  test("再次迁移不删除已有项目数据", () => {
    migrateDatabase(filename);
    const seeded = createDatabase(filename);
    seeded.sqlite.exec(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ('u1', 'alice', 'h', 'Alice', '2026-01-01')",
    );
    seeded.sqlite.exec(
      "INSERT INTO projects (id, user_id, capability_id, name, topic, profile, status, created_at, updated_at) VALUES ('p1', 'u1', 'cap', '项目一', '主题', 'default', 'draft', '2026-01-01', '2026-01-01')",
    );
    seeded.sqlite.close();

    migrateDatabase(filename);

    const database = createDatabase(filename);
    try {
      const count = database.sqlite.prepare("SELECT COUNT(*) AS c FROM projects").get() as {
        c: number;
      };
      expect(count.c).toBe(1);
    } finally {
      database.sqlite.close();
    }
  });
});
