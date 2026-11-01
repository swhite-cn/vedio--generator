import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { VideoForgeError } from "@videoforge/shared";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535),
    // JWT 密钥所在的环境变量名；密钥不得出现在 YAML 中，此处只存变量名
    jwt_secret_env: z.string().trim().min(1),
    // 访问令牌有效期，格式 <数字><h|m|s>，例如 12h / 30m / 45s
    access_token_ttl: z
      .string()
      .trim()
      .regex(/^\d+(h|m|s)$/, "access_token_ttl 需形如 12h / 30m / 45s"),
    // 是否开放自助注册
    allow_registration: z.boolean(),
    // admin 初始密码所在的环境变量名；变量未设置时回退内置默认口令
    admin_password_env: z.string().trim().min(1),
    // 单用户项目数量上限，范围 1-1000
    max_projects_per_user: z.number().int().min(1).max(1000),
  }),
  runtime: z.object({
    storage_root: z.string(),
    // 阶段工具全局并发上限，最小 1
    max_concurrent_stage: z.number().int().min(1),
    minimum_free_disk_gb: z.number().nonnegative(),
  }),
  tools: z.object({
    chromium_path: z.string(),
    ffmpeg_path: z.string(),
    ffprobe_path: z.string(),
  }),
  agent: z.object({
    // 是否向 agent 放开 bash / write / edit
    allow_shell_write_edit: z.boolean(),
  }),
  workflow: z.object({
    // 阶段失败后自救重试上限，范围 0-5
    max_stage_retry: z.number().int().min(0).max(5),
  }),
  engines: z.object({
    endpoints: z
      .object({
        ark: z
          .object({
            // Agent Plan 专用基础地址（严禁 /api/v3）
            base_url: z.url(),
            // 语言模型 ID（占位，需在本机配置中填写）
            chat_model: z.string().trim().min(1),
            // 图片生成模型 ID
            image_model: z.string().trim().min(1),
            // TTS 说话人
            tts_speaker: z.string().trim().min(1),
            // TTS 服务地址（openspeech，独立于 ark base_url）
            tts_base_url: z.url(),
            // TTS 资源 ID（如 seed-tts-2.0）
            tts_resource_id: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
  }),
  prompts: z
    .object({
      // 默认提示词集名称（config/prompts/<名称>/）；缺省时按 "default" 处理
      default_set: z.string().trim().min(1),
    })
    .optional(),
});

export type SystemConfig = z.infer<typeof configSchema>;

/**
 * 深度合并配置对象，保留默认配置中未被本机配置覆盖的字段。
 * @param base 默认配置
 * @param override 覆盖配置
 * @returns 合并后的配置
 */
function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object"
    ) {
      result[key] = mergeConfig(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 加载默认、本机和调用方覆盖配置，并转换相对路径为绝对路径。
 * @param options 配置加载参数
 * @returns 类型化系统配置
 */
export function loadSystemConfig(options: {
  rootDir: string;
  override?: Record<string, unknown>;
}): SystemConfig {
  const { rootDir, override = {} } = options;
  const readYaml = (path: string) =>
    existsSync(path) ? (parse(readFileSync(path, "utf8")) ?? {}) : {};
  const merged = mergeConfig(
    mergeConfig(
      readYaml(resolve(rootDir, "config/default.yaml")),
      readYaml(resolve(rootDir, "config/system.local.yaml")),
    ),
    override,
  );
  let parsed: SystemConfig;
  try {
    parsed = configSchema.parse(merged);
  } catch (err) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `系统配置校验失败：${(err as Error).message.slice(0, 300)}`,
    );
  }
  const toAbsolute = (value: string) => (isAbsolute(value) ? value : resolve(rootDir, value));
  const config: SystemConfig = {
    ...parsed,
    runtime: { ...parsed.runtime, storage_root: toAbsolute(parsed.runtime.storage_root) },
    tools: {
      ...parsed.tools,
      chromium_path: parsed.tools.chromium_path ? toAbsolute(parsed.tools.chromium_path) : "",
    },
  };
  console.info(`[config] loaded storage root: ${config.runtime.storage_root}`);
  return config;
}
