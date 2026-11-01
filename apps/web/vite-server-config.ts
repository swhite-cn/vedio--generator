import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

type ServerConfigFile = { server?: { port?: unknown } | null } | null;

/**
 * 从默认和本机 YAML 配置解析 Vite API 代理目标。
 * @param rootDir VideoForge 项目根目录
 * @returns 指向本机 Server 端口的代理目标
 */
export function loadApiProxyTarget(rootDir: string): string {
  const defaultPath = resolve(rootDir, "config/default.yaml");
  const localPath = resolve(rootDir, "config/system.local.yaml");
  const defaults = parse(readFileSync(defaultPath, "utf8")) as ServerConfigFile;
  const local = existsSync(localPath)
    ? (parse(readFileSync(localPath, "utf8")) as ServerConfigFile)
    : null;
  const localServer = local?.server;
  const hasLocalServer = local !== null && Object.prototype.hasOwnProperty.call(local, "server");
  if (
    hasLocalServer &&
    (localServer === null || typeof localServer !== "object" || Array.isArray(localServer))
  ) {
    throw new Error(
      "Invalid server.port in system YAML configuration; expected an integer from 1 to 65535.",
    );
  }
  const hasLocalPort =
    localServer !== undefined &&
    localServer !== null &&
    Object.prototype.hasOwnProperty.call(localServer, "port");
  const port = hasLocalPort ? localServer.port : defaults?.server?.port;

  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "Invalid server.port in system YAML configuration; expected an integer from 1 to 65535.",
    );
  }

  return `http://127.0.0.1:${port}`;
}
