import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 输出环境检查日志，统一保持可读且便于后续接入结构化日志。
 * @param {"INFO"|"WARN"|"ERROR"} level 日志级别
 * @param {string} message 日志内容
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

/**
 * 在 Windows PATH 中解析命令的实际可执行文件。
 * @param {string} command 命令名或可执行文件路径
 * @returns {Promise<string>} 可执行文件路径
 */
async function resolveExecutable(command) {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  const lookup = await execFileAsync("where.exe", [command], { windowsHide: true });
  return lookup.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? command;
}

/**
 * 执行外部命令并返回版本输出；命令不存在时返回 null。
 * @param {string} command 命令名或可执行文件路径
 * @param {string[]} args 命令参数
 * @returns {Promise<string|null>} 标准输出
 */
async function readCommandVersion(command, args) {
  try {
    if (process.platform === "win32" && command.toLowerCase() === "pnpm") {
      const result = await execFileAsync("cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], {
        windowsHide: true,
      });
      return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    }
    const resolved = await resolveExecutable(command);
    const result = await execFileAsync(resolved, args, { windowsHide: true });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch {
    return null;
  }
}

/**
 * 从简单 YAML 配置中读取关键标量，避免 Task 0 在依赖安装前引入第三方包。
 * @param {string} configPath 配置文件路径
 * @param {string} rootDir 项目根目录
 * @returns {{chromiumPath: string, ffmpegPath: string, ffprobePath: string, pythonExecutable: string, minimumFreeDiskGb: number, storageRoot: string}}
 */
function readMinimalConfig(configPath, rootDir) {
  const source = readFileSync(configPath, "utf8");
  const value = (key, fallback) => {
    const match = source.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m"));
    return match ? match[1].trim() : fallback;
  };
  return {
    chromiumPath: value("chromium_path", ""),
    ffmpegPath: value("ffmpeg_path", "ffmpeg"),
    ffprobePath: value("ffprobe_path", "ffprobe"),
    pythonExecutable:
      value("executable", "python").includes("/") || value("executable", "python").includes("\\")
        ? resolve(rootDir, value("executable", "python"))
        : value("executable", "python"),
    minimumFreeDiskGb: Number(value("minimum_free_disk_gb", "30")),
    storageRoot: value("storage_root", process.cwd()),
  };
}

/**
 * 校验 Windows 视频生产所需的运行时依赖。
 * @param {{rootDir?: string, configPath?: string, nodeVersion?: string, pnpmVersion?: string, pythonVersion?: string, commandVersions?: Record<string, string|null>}} options 校验覆盖项
 * @returns {Promise<Array<{name: string, status: "PASS"|"WARN"|"FAIL", message: string}>>} 检查结果
 */
export async function validateEnvironment(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = options.configPath ?? join(rootDir, "config", "system.local.yaml");
  const config = existsSync(configPath)
    ? readMinimalConfig(configPath, rootDir)
    : readMinimalConfig(join(rootDir, "config", "system.local.example.yaml"), rootDir);
  const results = [];

  const add = (name, status, message) => {
    results.push({ name, status, message });
    log(status === "FAIL" ? "ERROR" : status === "WARN" ? "WARN" : "INFO", `${name}: ${message}`);
  };

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0].replace(/^v/, ""));
  add("node", nodeMajor >= 20 ? "PASS" : "FAIL", `Node.js ${nodeVersion}，要求 >= 20`);

  const pnpmVersion = options.pnpmVersion ?? (await readCommandVersion("pnpm", ["--version"]));
  const pnpmMajor = pnpmVersion ? Number(pnpmVersion.trim().split(".")[0]) : 0;
  add(
    "pnpm",
    pnpmMajor === 10 ? "PASS" : "FAIL",
    pnpmVersion ? `pnpm ${pnpmVersion}` : "未找到 pnpm，要求 10.x",
  );

  const pythonVersion =
    options.pythonVersion ?? (await readCommandVersion(config.pythonExecutable, ["--version"]));
  const pythonMajorMatch = pythonVersion?.match(/Python\s+(\d+)/i);
  const pythonMajor = pythonMajorMatch ? Number(pythonMajorMatch[1]) : 0;
  add("python", pythonMajor >= 3 ? "PASS" : "FAIL", pythonVersion ?? "未找到 Python");

  for (const [name, command] of [
    ["ffmpeg", config.ffmpegPath],
    ["ffprobe", config.ffprobePath],
  ]) {
    const output =
      options.commandVersions?.[name] ?? (await readCommandVersion(command, ["-version"]));
    add(name, output ? "PASS" : "FAIL", output ? `${name} 可执行` : `未找到 ${command}`);
  }

  const chromiumPath = config.chromiumPath;
  const chromiumExists = chromiumPath
    ? existsSync(isAbsolute(chromiumPath) ? chromiumPath : resolve(rootDir, chromiumPath))
    : false;
  add(
    "chromium",
    chromiumExists ? "PASS" : "WARN",
    chromiumExists ? `路径存在：${chromiumPath}` : "未配置可执行 Chrome 路径，将由 Playwright 管理",
  );

  const storageRoot = isAbsolute(config.storageRoot)
    ? config.storageRoot
    : resolve(rootDir, config.storageRoot);
  try {
    const stats = statfsSync(dirname(storageRoot));
    const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
    const minimum = config.minimumFreeDiskGb;
    add(
      "storage",
      freeGb >= minimum ? "PASS" : "FAIL",
      `可用空间 ${freeGb.toFixed(2)} GB，要求 >= ${minimum} GB`,
    );
  } catch (error) {
    add("storage", "FAIL", `无法读取存储盘空间：${error.message}`);
  }

  return results;
}

/**
 * 作为命令行入口运行环境检查并设置退出码。
 * @returns {Promise<void>} 无返回值
 */
async function main() {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  const results = await validateEnvironment({ configPath });
  const failed = results.filter((item) => item.status === "FAIL");
  log(
    failed.length ? "ERROR" : "INFO",
    `环境检查完成：${results.length - failed.length}/${results.length} 项通过`,
  );
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
