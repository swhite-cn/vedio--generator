import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  CONTRACT_VERSION_V2,
  VideoForgeError,
  copyDocV2Schema,
  type CopyDocV2,
} from "@videoforge/shared";

/** copy.json 中单个场景的契约；imagePath/audioPath/htmlPath 由 image:gen / tts:gen / scene:gen 回填 */
export const copySceneSchema = z.object({
  sceneId: z.string().min(1),
  title: z.string(),
  narration: z.string().min(1),
  imagePrompt: z.string().min(1),
  imagePath: z.string().optional(),
  audioPath: z.string().optional(),
  htmlPath: z.string().optional(),
});

/** copy.json 顶层契约：贯穿 copy:gen → image:gen → tts:gen → storyboard:gen → render/compose */
export const copyDocSchema = z.object({
  topic: z.string().min(1),
  style: z.string().min(1),
  title: z.string().min(1),
  scenes: z.array(copySceneSchema).min(1),
});

export type CopyDoc = z.infer<typeof copyDocSchema>;

/** copy 文档的读取结果：带版本判别，供渐进迁移期间区分 v1 / v2。 */
export type CopyDocument =
  | { version: "1"; doc: CopyDoc }
  | { version: "2"; doc: CopyDocV2 };

/**
 * 读取并解析 JSON 文件；文件不可读或不是 JSON 时统一报 ADAPTER_PROTOCOL_INVALID。
 * @param path JSON 文件路径
 * @returns 解析后的任意 JSON 值
 */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 解析失败：${path}（${(err as Error).message}）`,
    );
  }
}

/**
 * 按是否存在 `contractVersion` 判定契约版本，再分别用对应 schema 校验。
 * 无 `contractVersion` 视为 v1（存量项目兼容）；已知版本非法或无对应 schema 时报错。
 * @param path copy.json 路径
 * @returns 带版本判别的文档
 */
export function readCopyDocument(path: string): CopyDocument {
  const raw = readJsonFile(path);
  const rawVersion =
    typeof raw === "object" && raw !== null
      ? (raw as { contractVersion?: unknown }).contractVersion
      : undefined;

  if (rawVersion === undefined) {
    return { version: "1", doc: parseCopyV1(raw, path) };
  }
  if (rawVersion === CONTRACT_VERSION_V2) {
    return { version: "2", doc: parseCopyV2(raw, path) };
  }
  throw new VideoForgeError(
    "ADAPTER_PROTOCOL_INVALID",
    `copy.json 契约版本不受支持：${path}（contractVersion=${String(rawVersion)}）`,
  );
}

/**
 * 校验 v1 文档结构。
 * @param raw 原始 JSON
 * @param path 文件路径（用于错误信息）
 * @returns v1 文档
 */
function parseCopyV1(raw: unknown, path: string): CopyDoc {
  const result = copyDocSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 校验 v2 文档结构。
 * @param raw 原始 JSON
 * @param path 文件路径（用于错误信息）
 * @returns v2 文档
 */
function parseCopyV2(raw: unknown, path: string): CopyDocV2 {
  const result = copyDocV2Schema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json v2 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 读取并校验 copy.json（仅 v1）；v2 文档请使用 `readCopyDocument`。
 * 保留该函数用于尚未迁移的 v1 阶段工具，避免一次性改完所有调用方。
 * @param path copy.json 路径
 * @returns v1 文档
 */
export function readCopyDoc(path: string): CopyDoc {
  const document = readCopyDocument(path);
  if (document.version === "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 为 v2，当前阶段尚未迁移：${path}（请使用 readCopyDocument）`,
    );
  }
  return document.doc;
}

/**
 * 以 UTF-8、2 空格缩进写 copy.json；自动创建缺失的父目录（工作区可能尚未建立）。
 */
export function writeCopyDoc(path: string, doc: CopyDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
}

/**
 * 以 UTF-8、2 空格缩进写 copy.json v2；自动创建缺失的父目录。
 * @param path 输出路径
 * @param doc v2 文档
 */
export function writeCopyDocV2(path: string, doc: CopyDocV2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
}
