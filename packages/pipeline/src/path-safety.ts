import { basename, isAbsolute, relative, resolve } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/** 项目名长度上限（见设计文档 §8.3：1..64）。 */
const PROJECT_NAME_MAX_LENGTH = 64;

/** Windows 保留字符（见设计文档 §8.3：`: * ? " < > |`）。 */
const ILLEGAL_PROJECT_NAME_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/**
 * Windows 保留设备名（不区分大小写）。
 *
 * 这些名字即使带扩展名也会被系统解释为设备，无法当作普通文件读写；一旦由命令或工具
 * 误创建（典型来源是 cmd 风格的 `2>nul` 重定向），还会连带破坏 grep / find 等遍历型工具。
 * 见 https://learn.microsoft.com/windows/win32/fileio/naming-a-file
 */
const WINDOWS_RESERVED_BASE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * 判断名称是否为 Windows 保留设备名（见设计文档 §8.3 文件层）。
 * 判定口径与 Windows 一致：取首个点号之前的主名、去首尾空白、不区分大小写，
 * 因此 `nul`、`NUL.txt`、`nul ` 都判为保留名。
 * @param name 文件或目录名（不含路径分隔符）
 * @returns 是保留设备名返回 true
 */
export function isWindowsReservedName(name: string): boolean {
  const baseName = name.split(".")[0]?.trim().toLowerCase() ?? "";
  return WINDOWS_RESERVED_BASE_NAMES.has(baseName);
}

/**
 * 将工件相对路径解析到存储根目录，并拒绝目录逃逸。
 * 同时拒绝 Windows 保留设备名（如 `nul`）作为工件名——这类名字无法按普通文件读写。
 * @param storageRoot 工件存储根目录
 * @param artifactRelativePath 工件相对路径
 * @returns 安全的绝对路径
 */
export function resolveArtifactPath(storageRoot: string, artifactRelativePath: string): string {
  const root = resolve(storageRoot);
  const target = resolve(root, artifactRelativePath);
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    console.error(`[path-safety] rejected path: ${artifactRelativePath}`);
    throw new VideoForgeError(
      "PATH_OUTSIDE_STORAGE",
      `Artifact path escapes storage root: ${artifactRelativePath}`,
    );
  }
  const baseName = basename(target);
  if (isWindowsReservedName(baseName)) {
    console.error(`[path-safety] rejected reserved device name: ${baseName}`);
    throw new VideoForgeError(
      "PATH_OUTSIDE_STORAGE",
      `Artifact path uses a Windows reserved device name: ${baseName}`,
    );
  }
  console.info(`[path-safety] resolved artifact: ${target}`);
  return target;
}

/**
 * 校验并归一化用户输入的项目名（见设计文档 §8.3）。
 * 处理：Unicode NFC 归一化 → 去首尾空白与末尾点 → 长度 1..64 →
 * 禁 `/ \ ..`、禁 Windows 保留字符（`: * ? " < > |`）与控制字符；允许中文与空格。
 * @param name 用户输入的项目名
 * @returns 归一化后的安全项目名
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) 名称非法时
 */
export function validateProjectName(name: string): string {
  // NFC 归一化后去掉首部空白、尾部空白与末尾点（设计文档 §8.3）
  const normalized = name.normalize("NFC").replace(/^[\s]+|[\s.]+$/g, "");
  if (normalized.length < 1 || normalized.length > PROJECT_NAME_MAX_LENGTH) {
    console.error(`[path-safety] rejected project name (length): ${JSON.stringify(name)}`);
    throw new VideoForgeError(
      "PATH_OUTSIDE_STORAGE",
      `Invalid project name length (expected 1..${PROJECT_NAME_MAX_LENGTH}): ${JSON.stringify(name)}`,
    );
  }
  if (normalized.includes("..")) {
    console.error(`[path-safety] rejected project name (traversal): ${JSON.stringify(name)}`);
    throw new VideoForgeError(
      "PATH_OUTSIDE_STORAGE",
      `Invalid project name (path traversal): ${JSON.stringify(name)}`,
    );
  }
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    // 控制字符（C0 0x00-0x1F 与 DEL 0x7F）与 Windows 保留字符一律拒绝
    if (ILLEGAL_PROJECT_NAME_CHARS.has(char) || code < 0x20 || code === 0x7f) {
      console.error(`[path-safety] rejected project name (illegal char): ${JSON.stringify(name)}`);
      throw new VideoForgeError(
        "PATH_OUTSIDE_STORAGE",
        `Invalid project name character ${JSON.stringify(char)} in: ${JSON.stringify(name)}`,
      );
    }
  }
  // Windows 保留设备名无法作为目录名落盘（如 `nul` 会被解释为设备），提前拒绝
  if (isWindowsReservedName(normalized)) {
    console.error(
      `[path-safety] rejected project name (reserved device name): ${JSON.stringify(name)}`,
    );
    throw new VideoForgeError(
      "PATH_OUTSIDE_STORAGE",
      `Project name is a Windows reserved device name: ${JSON.stringify(name)}`,
    );
  }
  console.info(`[path-safety] validated project name: ${normalized}`);
  return normalized;
}

/**
 * 断言目标路径仍位于给定用户根目录内，拒绝目录逃逸（见设计文档 §8.3 文件层）。
 * 复用 `relative()` 判断风格：相对路径以 `..` 开头、为绝对路径或含盘符冒号即判越界。
 * @param root 用户根目录（如 `storage/users/<userId>`）
 * @param target 待校验的绝对路径
 * @returns 通过校验的 `target`
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) 目标越出根目录时
 */
export function assertInsideUserRoot(root: string, target: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const relativePath = relative(rootPath, targetPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes(":")) {
    console.error(`[path-safety] rejected path outside user root: ${target}`);
    throw new VideoForgeError("PATH_OUTSIDE_STORAGE", `Path escapes user root: ${target}`);
  }
  return targetPath;
}
