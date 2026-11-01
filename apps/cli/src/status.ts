import { existsSync, statSync, statfsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import { loadSystemConfig } from "@videoforge/pipeline";
import { createDatabase, runs, sessions } from "@videoforge/server/src/db/index.js";

/** 业务统计（活跃 run 与会话数）。 */
export interface ActivityStats {
  activeRuns: number;
  sessions: number;
}

/** `status` 命令输出的状态报告（stdout 一行 JSON，见设计文档 §3.5）。 */
export interface StatusReport {
  /** `/health` 探活是否成功。 */
  serverOnline: boolean;
  /** 配置的服务端口。 */
  port: number;
  /** TCP 端口是否已被占用。 */
  portInUse: boolean;
  /** 工件存储根目录（已转为绝对路径）。 */
  storageRoot: string;
  /** 存储盘可用空间（GB）；读不到为 null。 */
  freeDiskGb: number | null;
  /** SQLite 数据库文件路径（`<storage_root>/videoforge.db`）。 */
  dbPath: string;
  /** 数据库文件体积（字节）；DB 不存在为 null。 */
  dbSizeBytes: number | null;
  /** 业务统计；DB 不存在为 null。 */
  activity: ActivityStats | null;
  /** 面向操作者的降级提示（server 未运行 / DB 未初始化 / 端口被占用）。 */
  hints: string[];
}

/** 可注入依赖（默认走真实网络/文件系统；测试全部注入，避免真实 IO）。 */
export interface StatusDeps {
  probeHealth?: (url: string) => Promise<boolean>;
  probePort?: (host: string, port: number) => Promise<boolean>;
  freeDiskGb?: (path: string) => number | null;
  collectActivity?: (dbPath: string) => ActivityStats | null;
}

/** 活跃 run 的状态集合（与 `runs.status` 枚举对齐，见设计文档 §11）。 */
const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_review"];

/**
 * 默认 `/health` 探活：2 秒超时，任何异常或非 2xx 一律视为离线。
 * @param url 探活地址
 * @returns 探活成功返回 true
 */
async function defaultProbeHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 默认 TCP 端口探活：500ms 超时，连接成功视为占用。
 * @param host 主机名
 * @param port 端口
 * @returns 端口已被占用返回 true
 */
function defaultProbePort(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePort) => {
    const socket = createConnection({ host, port });
    const settle = (occupied: boolean) => {
      socket.destroy();
      resolvePort(occupied);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

/**
 * 默认磁盘可用量：读取路径所在卷的可用空间（GB，两位小数），失败返回 null。
 * @param path 探测量所在目录
 * @returns 可用 GB 数或 null
 */
function defaultFreeDiskGb(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(((Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3).toFixed(2));
  } catch {
    return null;
  }
}

/**
 * 默认业务统计：DB 不存在时返回 null（不创建文件），否则以 drizzle 只读计数活跃 run 与会话数。
 * 任何异常按 null 处理并打 WARN，不向上抛错。
 * @param dbPath SQLite 文件路径
 * @returns 统计结果或 null
 */
function defaultCollectActivity(dbPath: string): ActivityStats | null {
  if (!existsSync(dbPath)) return null;
  let sqlite: { close: () => void } | undefined;
  try {
    const connection = createDatabase(dbPath);
    sqlite = connection.sqlite;
    const db = connection.db;
    const activeRuns = db
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.status, ACTIVE_RUN_STATUSES))
      .all().length;
    const sessionCount = db.select({ id: sessions.id }).from(sessions).all().length;
    return { activeRuns, sessions: sessionCount };
  } catch (error) {
    console.warn(`[cli] status: 读取数据库统计失败：${(error as Error).message}`);
    return null;
  } finally {
    sqlite?.close();
  }
}

/**
 * 组装状态报告（server 不可用时降级提示，不抛错）。
 * @param rootDir 仓库根目录
 * @param deps 可注入依赖（测试用；缺省走真实网络/文件系统）
 * @returns 状态报告
 */
export async function buildStatusReport(
  rootDir: string,
  deps: StatusDeps = {},
): Promise<StatusReport> {
  const config = loadSystemConfig({ rootDir });
  const port = config.server.port;
  const storageRoot = config.runtime.storage_root;
  const dbPath = resolve(storageRoot, "videoforge.db");

  const probeHealth = deps.probeHealth ?? defaultProbeHealth;
  const probePort = deps.probePort ?? defaultProbePort;
  const readFreeDiskGb = deps.freeDiskGb ?? defaultFreeDiskGb;
  const collectActivity = deps.collectActivity ?? defaultCollectActivity;

  const [serverOnline, portInUse] = await Promise.all([
    probeHealth(`http://127.0.0.1:${port}/health`),
    probePort("127.0.0.1", port),
  ]);

  const dbSizeBytes = existsSync(dbPath) ? statSync(dbPath).size : null;
  const activity = collectActivity(dbPath);
  const freeDiskGb = readFreeDiskGb(dirname(storageRoot));

  const hints: string[] = [];
  if (!serverOnline) {
    hints.push("本机 server 未运行（/health 探活失败）：请先执行 pnpm run server:dev");
  }
  if (activity === null) {
    hints.push("数据库尚未初始化：请先执行 pnpm --filter @videoforge/cli start db:migrate");
  }
  if (portInUse && !serverOnline) {
    hints.push(`端口 ${port} 被其它进程占用`);
  }

  return {
    serverOnline,
    port,
    portInUse,
    storageRoot,
    freeDiskGb,
    dbPath,
    dbSizeBytes,
    activity,
    hints,
  };
}

/**
 * `status` 命令：向 stdout 输出一行 JSON；server 不可用也返回（退出码 0，见设计文档 §3.5）。
 * @param rootDir 仓库根目录
 * @param flags 解析后的标志表（本命令不消费任何标志）
 * @param deps 可注入依赖（测试用）
 */
export async function runStatus(
  rootDir: string,
  flags: Record<string, string>,
  deps?: StatusDeps,
): Promise<void> {
  const report = await buildStatusReport(rootDir, deps);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
