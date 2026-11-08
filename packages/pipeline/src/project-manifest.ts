import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VideoForgeError } from "@videoforge/shared";

/** 项目清单文件相对项目目录的路径（POSIX `/` 分隔）。 */
export const PROJECT_MANIFEST_FILE = "manifest.json";

/** 契约版本格式：`1.0` / `2.0` 这类主次版本。 */
const contractVersionPattern = /^\d+\.\d+$/;

/** 项目清单 schema：用于导出/迁移时识别项目契约与主题快照。 */
export const projectManifestSchema = z.object({
  // 清单结构版本，当前固定 1
  version: z.literal("1"),
  // 项目契约版本，必须形如 1.0 / 2.0
  contractVersion: z.string().trim().regex(contractVersionPattern, "contractVersion 需形如 1.0"),
  // 主题 ID 快照；未设置主题时为空
  themeId: z.string().trim().min(1).nullable(),
  // 首次创建时间（ISO 8601）
  createdAt: z.string().trim().min(1),
  // 最近更新时间（ISO 8601）
  updatedAt: z.string().trim().min(1),
});

/** 项目清单类型。 */
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

/** 创建/确保清单时的入参。 */
export interface EnsureProjectManifestInput {
  /** 项目契约版本；新项目由创建入口显式传入。 */
  contractVersion: string;
  /** 项目主题 ID；未设置时为空。 */
  themeId?: string | null;
  /** 时间戳（测试注入用）；缺省取当前时间。 */
  now?: string;
}

/**
 * 校验任意值为项目清单。
 * @param raw 待校验值
 * @param path 错误信息中的路径
 * @returns 合法清单
 */
function parseProjectManifest(raw: unknown, path: string): ProjectManifest {
  const result = projectManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `项目清单结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 读取项目根目录的 manifest.json；文件不存在时返回 null。
 * 旧清单缺少 contractVersion 时按 `1.0` 归一化，保证旧项目可续跑。
 * @param projectDir 项目工作目录
 * @returns 清单或 null
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 文件非 JSON 或结构非法时
 */
export function readProjectManifest(projectDir: string): ProjectManifest | null {
  const path = join(projectDir, PROJECT_MANIFEST_FILE);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `项目清单解析失败：${path}（${(err as Error).message}）`,
    );
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    raw = {
      ...record,
      version: record.version ?? "1",
      contractVersion: record.contractVersion ?? "1.0",
      themeId: record.themeId ?? null,
    };
  }
  return parseProjectManifest(raw, path);
}

/**
 * 写入项目清单（覆盖）；调用方需保证已确认要更新快照。
 * @param projectDir 项目工作目录
 * @param manifest 清单内容
 */
export function writeProjectManifest(projectDir: string, manifest: ProjectManifest): void {
  const valid = parseProjectManifest(manifest, join(projectDir, PROJECT_MANIFEST_FILE));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, PROJECT_MANIFEST_FILE),
    JSON.stringify(valid, null, 2),
    "utf-8",
  );
}

/**
 * 确保项目清单存在：不存在则创建，已存在则原样返回（不覆盖历史快照）。
 * @param projectDir 项目工作目录
 * @param input 契约版本与主题
 * @returns 当前生效的清单
 */
export function ensureProjectManifest(
  projectDir: string,
  input: EnsureProjectManifestInput,
): ProjectManifest {
  const existing = readProjectManifest(projectDir);
  if (existing) return existing;

  const now = input.now ?? new Date().toISOString();
  const manifest: ProjectManifest = {
    version: "1",
    contractVersion: input.contractVersion,
    themeId: input.themeId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeProjectManifest(projectDir, manifest);
  return manifest;
}
