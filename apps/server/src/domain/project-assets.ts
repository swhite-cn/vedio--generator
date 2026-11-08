import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { assertInsideUserRoot, isWindowsReservedName } from "@videoforge/pipeline";
import type {
  Actor,
  PipelineStage,
  Project,
  ProjectAsset,
  ProjectAssetKind,
} from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import type { ArtifactIndex } from "../http/artifacts.js";
import { createProjectAsset, listProjectAssets } from "../db/repositories/asset-repository.js";

/** 上传文件白名单：扩展名与 MIME 必须成对匹配。 */
const UPLOAD_TYPES: ReadonlyArray<{
  extensions: readonly string[];
  mimeType: string;
  kind: ProjectAssetKind;
}> = [
  { extensions: [".txt"], mimeType: "text/plain", kind: "document" },
  { extensions: [".md"], mimeType: "text/markdown", kind: "document" },
  { extensions: [".pdf"], mimeType: "application/pdf", kind: "document" },
  { extensions: [".png"], mimeType: "image/png", kind: "image" },
  { extensions: [".jpg", ".jpeg"], mimeType: "image/jpeg", kind: "image" },
  { extensions: [".webp"], mimeType: "image/webp", kind: "image" },
  { extensions: [".mp3"], mimeType: "audio/mpeg", kind: "audio" },
  { extensions: [".wav"], mimeType: "audio/wav", kind: "audio" },
  { extensions: [".m4a"], mimeType: "audio/mp4", kind: "audio" },
  { extensions: [".ogg"], mimeType: "audio/ogg", kind: "audio" },
];

/** 流水线阶段到统一项目资产类型的映射（caption 字幕轨归入时间轴类资产）。 */
const GENERATED_STAGE_KINDS: Readonly<Record<PipelineStage, ProjectAssetKind>> = {
  copy: "copy",
  image: "image",
  scene: "scene",
  tts: "audio",
  captions: "timeline",
  storyboard: "timeline",
  render: "frames",
  compose: "video",
};

/** 按文件扩展名推导可展示的 MIME 类型。 */
function generatedMimeType(relativePath: string): string {
  switch (extname(relativePath).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".html":
      return "text/html";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/**
 * 校验并归一化上传文件名。
 * @param filename multipart 上报的文件名
 * @returns 可安全写入的单段文件名
 */
export function validateUploadName(filename: string): string {
  const normalized = filename.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 160 ||
    normalized !== basename(normalized) ||
    normalized.includes("..") ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(normalized) ||
    isWindowsReservedName(normalized)
  ) {
    throw new VideoForgeError("ASSET_INVALID", "上传文件名非法");
  }
  return normalized;
}

/**
 * 按扩展名和 MIME 类型判定可接受资产类型。
 * @param filename 已校验的文件名
 * @param mimeType multipart 声明的 MIME 类型
 * @returns 项目资产类型
 */
export function classifyUpload(filename: string, mimeType: string): ProjectAssetKind {
  const extension = extname(filename).toLowerCase();
  const match = UPLOAD_TYPES.find(
    (item) => item.extensions.includes(extension) && item.mimeType === mimeType.toLowerCase(),
  );
  if (!match) {
    throw new VideoForgeError("ASSET_TYPE_UNSUPPORTED", "仅支持文档、图片和背景音乐文件");
  }
  return match.kind;
}

/**
 * 解析单个上传文件的受控目标路径。
 * @param projectDir 当前项目绝对目录
 * @param assetId 服务端生成的资产 UUID
 * @param filename 已校验的单段文件名
 * @returns 项目目录内的绝对目标路径
 */
export function resolveUploadPath(projectDir: string, assetId: string, filename: string): string {
  const target = resolve(projectDir, "assets", "uploads", assetId, filename);
  assertInsideUserRoot(projectDir, target);
  return target;
}

/**
 * 将绝对资产文件路径转换为项目相对 POSIX 路径。
 * @param projectDir 当前项目绝对目录
 * @param absolutePath 当前项目内文件绝对路径
 * @returns 使用 `/` 的项目相对路径
 */
export function toProjectRelativeAssetPath(projectDir: string, absolutePath: string): string {
  const safePath = assertInsideUserRoot(projectDir, absolutePath);
  return relative(resolve(projectDir), safePath).split(sep).join("/");
}

/**
 * 把已写好的临时上传文件原子移动到资产目录。
 * @param temporaryPath multipart 创建的临时文件
 * @param targetPath 项目内最终目标文件
 */
export async function moveUploadedFile(temporaryPath: string, targetPath: string): Promise<void> {
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 读取已落盘上传文件大小，并拒绝超过配置的单文件限制。
 * @param targetPath 项目内目标路径
 * @param maxBytes 最大字节数
 * @returns 文件字节数
 */
export async function assertUploadSize(targetPath: string, maxBytes: number): Promise<number> {
  const size = (await stat(targetPath)).size;
  if (size <= 0) {
    throw new VideoForgeError("ASSET_INVALID", "上传文件不能为空");
  }
  if (size > maxBytes) {
    throw new VideoForgeError("ASSET_TOO_LARGE", "上传文件超过单文件大小限制");
  }
  return size;
}

/**
 * 校验常见二进制文件签名，避免仅依赖 multipart 声明的 MIME 类型。
 * 纯文本与 Markdown 不要求魔数；未知或不匹配的二进制内容会被拒绝。
 * @param targetPath 已写入项目受控临时目录的文件
 * @param mimeType 已通过扩展名配对校验的 MIME 类型
 */
export async function validateUploadSignature(targetPath: string, mimeType: string): Promise<void> {
  if (mimeType === "text/plain" || mimeType === "text/markdown") return;
  const header = await readFile(targetPath, { encoding: null, flag: "r" }).then((value) =>
    value.subarray(0, 16),
  );
  const prefix = header.toString("ascii");
  const valid =
    (mimeType === "application/pdf" && prefix.startsWith("%PDF-")) ||
    (mimeType === "image/png" &&
      header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mimeType === "image/jpeg" && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) ||
    (mimeType === "image/webp" &&
      prefix.startsWith("RIFF") &&
      header.subarray(8, 12).toString("ascii") === "WEBP") ||
    (mimeType === "audio/mpeg" && (prefix.startsWith("ID3") || header[0] === 0xff)) ||
    (mimeType === "audio/wav" &&
      prefix.startsWith("RIFF") &&
      header.subarray(8, 12).toString("ascii") === "WAVE") ||
    (mimeType === "audio/ogg" && prefix.startsWith("OggS")) ||
    (mimeType === "audio/mp4" && header.subarray(4, 8).toString("ascii") === "ftyp");
  if (!valid) {
    throw new VideoForgeError("ASSET_INVALID", "上传文件内容与声明类型不匹配");
  }
}

/**
 * 将已存在的流水线产物幂等同步为项目资产。
 * 扫描结果由能力声明驱动的 `ArtifactIndex` 提供；同一项目、同一路径只登记一次，
 * 因此旧项目首次打开与工作流运行中的重复刷新均不会生成重复资产。
 * @param db Drizzle 数据库实例
 * @param actor 当前请求主体
 * @param project 当前项目
 * @param artifactIndex 当前项目扫描出的流水线产物
 * @returns 本次新登记的生成资产
 */
export function syncGeneratedProjectAssets(
  db: any,
  actor: Actor,
  project: Project,
  artifactIndex: ArtifactIndex,
): ProjectAsset[] {
  const existingPaths = new Set(
    listProjectAssets(db, actor, project.id)
      .filter((asset) => asset.source === "generated")
      .map((asset) => asset.relative_path),
  );
  const created: ProjectAsset[] = [];

  for (const entry of artifactIndex.entries) {
    if (existingPaths.has(entry.relativePath)) continue;
    created.push(
      createProjectAsset(db, actor, {
        projectId: project.id,
        source: "generated",
        kind: GENERATED_STAGE_KINDS[entry.stage],
        label: basename(entry.relativePath),
        relativePath: entry.relativePath,
        mimeType: generatedMimeType(entry.relativePath),
        sizeBytes: entry.sizeBytes,
        stage: entry.stage,
        metadata: { stage_label: entry.label },
      }),
    );
    existingPaths.add(entry.relativePath);
  }
  if (created.length > 0) {
    console.info(`[project-assets] 已登记 ${created.length} 个流水线生成资产：${project.id}`);
  }
  return created;
}
