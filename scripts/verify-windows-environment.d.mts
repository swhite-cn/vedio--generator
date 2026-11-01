/** validateEnvironment 的调用覆盖项；缺省字段从本机环境实测 */
export interface ValidateEnvironmentOptions {
  rootDir?: string;
  configPath?: string;
  nodeVersion?: string;
  pnpmVersion?: string;
  pythonVersion?: string;
  commandVersions?: Record<string, string | null>;
}

/** 单条环境检查结果 */
export interface EnvironmentCheckResult {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

/** 校验 Windows 视频生产所需的运行时依赖（Node/pnpm/Python/ffmpeg/ffprobe/Chromium/磁盘空间） */
export function validateEnvironment(
  options?: ValidateEnvironmentOptions,
): Promise<EnvironmentCheckResult[]>;
