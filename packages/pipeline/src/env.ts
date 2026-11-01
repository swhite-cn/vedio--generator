import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 解析仓库根目录的 .env.local 并注入 process.env；已存在的键不覆盖，文件缺失时静默跳过。
 * 注意：本函数与调用方均不得把读取到的值写入日志。
 */
export function loadLocalEnv(rootDir: string): void {
  const envPath = resolve(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * 获取火山方舟 API Key：先加载 .env.local，再读 ARK_API_KEY；缺失抛 CONFIG_INVALID。
 */
export function getArkApiKey(rootDir: string): string {
  loadLocalEnv(rootDir);
  const key = process.env.ARK_API_KEY?.trim();
  if (!key) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "缺少 ARK_API_KEY：请在环境变量或仓库根目录 .env.local 中配置",
    );
  }
  return key;
}
