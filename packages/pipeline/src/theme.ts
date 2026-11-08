import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { VideoForgeError, themeSchema, type ThemeV2 } from "@videoforge/shared";

/**
 * 主题资源加载与项目快照。
 * - 主题源文件：`config/themes/<id>/theme.yaml`，目录名必须与 `theme.id` 一致；
 * - 项目快照：项目根目录 `theme.resolved.json`，创建时写入一次，之后只读不覆盖，
 *   保证历史项目即使主题文件被改版也能按创建时的视觉语言重建。
 */

/** 主题源文件名。 */
export const THEME_FILE_NAME = "theme.yaml";

/** 项目主题快照文件名。 */
export const THEME_SNAPSHOT_FILE = "theme.resolved.json";

/** 主题快照 schema：结构版本 + 来源 + 解析时间 + 完整主题。 */
export const themeSnapshotSchema = z.object({
  // 快照结构版本，当前固定 1
  version: z.literal("1"),
  // 来源主题 ID，必须与 theme.id 一致
  themeId: z.string().trim().min(1),
  // 解析写入时间（ISO 8601）
  resolvedAt: z.string().trim().min(1),
  // 解析后的完整主题（token 已展开，不含外部引用）
  theme: themeSchema,
});

/** 项目主题快照类型。 */
export type ThemeSnapshot = z.infer<typeof themeSnapshotSchema>;

/** 加载主题的入参。 */
export interface LoadThemeInput {
  /** 仓库根目录（用于定位 `config/themes`）。 */
  rootDir: string;
  /** 主题 ID（等于 config/themes 下的目录名）。 */
  themeId: string;
}

/**
 * 解析主题对象，失败统一报 `CONFIG_INVALID`。
 * @param raw YAML 解析后的原始值
 * @param path 主题文件路径（用于错误定位）
 * @returns 合法主题
 */
function parseTheme(raw: unknown, path: string): ThemeV2 {
  const result = themeSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `主题结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 从 `config/themes/<id>/theme.yaml` 加载并校验主题。
 * @param input 仓库根目录与主题 ID
 * @returns 解析后的主题
 * @throws VideoForgeError(`CONFIG_INVALID`) 主题缺失、YAML 非法、结构非法或目录名与 id 不一致
 */
export function loadTheme(input: LoadThemeInput): ThemeV2 {
  const themeId = input.themeId.trim();
  if (!themeId) {
    throw new VideoForgeError("CONFIG_INVALID", "主题 ID 不能为空");
  }

  const path = join(input.rootDir, "config", "themes", themeId, THEME_FILE_NAME);
  if (!existsSync(path)) {
    throw new VideoForgeError("CONFIG_INVALID", `主题不存在：${themeId}（缺少 ${path}）`);
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `主题文件解析失败：${path}（${(err as Error).message}）`,
    );
  }

  const theme = parseTheme(raw, path);
  if (theme.id !== themeId) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `主题 ID 与目录不一致：目录 ${themeId}，文件内 id ${theme.id}`,
    );
  }
  return theme;
}

/**
 * 列出全部可用主题（扫描 `config/themes/<id>/theme.yaml`）。
 * 单个主题解析失败时跳过并告警，不阻断列表（坏主题不应拖垮新建项目入口）。
 * @param rootDir 仓库根目录
 * @returns 主题列表（按 ID 字典序）
 */
export function listThemes(rootDir: string): ThemeV2[] {
  const themesDir = join(rootDir, "config", "themes");
  if (!existsSync(themesDir)) return [];
  const ids = readdirSync(themesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const themes: ThemeV2[] = [];
  for (const themeId of ids) {
    try {
      themes.push(loadTheme({ rootDir, themeId }));
    } catch (err) {
      console.warn(`[theme] 跳过非法主题 ${themeId}：${(err as Error).message}`);
    }
  }
  return themes;
}

/**
 * 把主题解析为可落盘的项目快照。
 * @param theme 已加载主题
 * @param now 解析时间（测试注入用）；缺省当前时间
 * @returns 主题快照
 */
export function resolveThemeSnapshot(theme: ThemeV2, now?: string): ThemeSnapshot {
  return {
    version: "1",
    themeId: theme.id,
    resolvedAt: now ?? new Date().toISOString(),
    theme,
  };
}

/**
 * 读取项目主题快照；文件不存在时返回 null。
 * @param projectDir 项目工作目录
 * @returns 主题快照或 null
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 文件非 JSON 或结构非法时
 */
export function readThemeSnapshot(projectDir: string): ThemeSnapshot | null {
  const path = join(projectDir, THEME_SNAPSHOT_FILE);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `主题快照解析失败：${path}（${(err as Error).message}）`,
    );
  }

  const result = themeSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `主题快照结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 写入项目主题快照（覆盖）；调用方需确认要更新历史快照。
 * @param projectDir 项目工作目录
 * @param snapshot 主题快照
 */
export function writeThemeSnapshot(projectDir: string, snapshot: ThemeSnapshot): void {
  const valid = themeSnapshotSchema.parse(snapshot);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, THEME_SNAPSHOT_FILE), JSON.stringify(valid, null, 2), "utf-8");
}

/**
 * 确保项目主题快照存在：不存在则写入，已存在则原样返回（冻结创建时视觉语言）。
 * 切换主题不会改写既有快照，也不会改变镜头组件选型。
 * @param projectDir 项目工作目录
 * @param theme 已加载主题
 * @param now 解析时间（测试注入用）
 * @returns 当前生效的主题快照
 */
export function ensureThemeSnapshot(
  projectDir: string,
  theme: ThemeV2,
  now?: string,
): ThemeSnapshot {
  const existing = readThemeSnapshot(projectDir);
  if (existing) return existing;

  const snapshot = resolveThemeSnapshot(theme, now);
  writeThemeSnapshot(projectDir, snapshot);
  return snapshot;
}
