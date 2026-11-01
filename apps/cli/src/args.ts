import { VideoForgeError } from "@videoforge/shared";

/**
 * 解析 `<command> --key value ...` 形式的 argv；布尔标志不支持，未知参数原样忽略。
 */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith("--") && i + 1 < rest.length) {
      flags[token.slice(2)] = rest[i + 1];
      i += 1;
    }
  }
  return { command, flags };
}

/**
 * 取必需标志；缺失时抛 CONFIG_INVALID。
 */
export function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim();
  if (!value) {
    throw new VideoForgeError("CONFIG_INVALID", `缺少必需参数 --${name}`);
  }
  return value;
}
