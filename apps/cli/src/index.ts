// CLI 定位为仓库运维入口（见设计文档 §3.5）：不参与流水线编排，不写 messages/runs/tool_calls，
// 也不依赖 server 在线（status 在 server 不可用时降级为提示，不报错退出）。
// 契约：stdout 只输出一行机器可读 JSON，诊断走 stderr；错误码沿用 VideoForgeError。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VideoForgeError } from "@videoforge/shared";
import { parseArgs } from "./args.js";
import { runDoctor } from "./doctor.js";
import { runStatus } from "./status.js";
import { runDbMigrate } from "./db-migrate.js";
import { runDbUser } from "./db-user.js";
import { runStoragePrune } from "./storage-prune.js";
import { runProjectVerify } from "./project-verify.js";

// 诊断日志统一改道 stderr，保证 stdout 只承载一行机器可读 JSON（结果或错误）
console.info = (...args: unknown[]) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.log = console.info;

/** 命令处理器签名：接收仓库根目录与标志表 */
type CommandHandler = (rootDir: string, flags: Record<string, string>) => Promise<void>;

const handlers: Record<string, CommandHandler> = {
  status: runStatus,
  "db:migrate": runDbMigrate,
  "db:user": runDbUser,
  "storage:prune": runStoragePrune,
  "project:verify": runProjectVerify,
};

/**
 * 把异常归一化为机器可读错误对象；VideoForgeError 保留稳定错误码，其余归为 UNEXPECTED_ERROR。
 */
function toErrorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof VideoForgeError) {
    return { code: err.code, message: err.message };
  }
  return { code: "UNEXPECTED_ERROR", message: err instanceof Error ? err.message : String(err) };
}

/**
 * 解析 CLI 命令并分发执行；命令失败时 stdout 输出错误 JSON、stderr 输出诊断，退出码非 0。
 */
async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  if (command === "doctor") {
    process.exitCode = await runDoctor(projectRoot);
    return;
  }
  const handler = handlers[command];
  if (!handler) {
    process.stderr.write(
      `未知命令：${command || "(空)"}；可用命令：doctor、status、db:migrate、db:user、storage:prune、project:verify\n`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    await handler(projectRoot, flags);
  } catch (err) {
    const payload = toErrorPayload(err);
    process.stderr.write(`${payload.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: payload })}\n`);
    process.exitCode = 1;
  }
}

await main();
