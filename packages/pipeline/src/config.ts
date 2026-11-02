import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { VideoForgeError } from "@videoforge/shared";

/**
 * bash 命令预检护栏规则（配置驱动，见 `config/default.yaml` 的 `agent.command_guardrails`）。
 *
 * 规则是**数据不是代码**：新增一类需要防护的命令写法只需在 YAML 里追加一条，
 * 不必改服务端代码——这是对「黑名单写死在代码里会被绕过、且后期不断出现新变体」的正面回应。
 */
const commandGuardrailSchema = z
  .object({
    // 规则标识，用于报错信息与留痕定位；需在规则集内唯一（不做强制校验，重复时按先命中为准）
    id: z.string().trim().min(1),
    // 对 bash 命令原文匹配的 ECMAScript 正则；命中后按 action 处理
    pattern: z.string().min(1),
    // 正则标志，只允许 g i m s u y 的组合；留空默认区分大小写
    flags: z
      .string()
      .trim()
      .regex(/^[gimsuy]*$/, "flags 只能是 g i m s u y 的组合")
      .default(""),
    // 命中动作：rewrite=替换后继续执行；reject=拒绝执行并把 hint 作为错误返回给模型
    action: z.enum(["rewrite", "reject"]),
    // action=rewrite 时的替换字面量，替换「整段匹配」；用字面量而非 $1 捕获组引用，避免歧义
    replacement: z.string().optional(),
    // 命中原因与正确做法；reject 时作为错误信息返回给模型，引导其改用正确写法
    hint: z.string().trim().min(1),
  })
  .strict()
  .refine((rule) => rule.action !== "rewrite" || typeof rule.replacement === "string", {
    message: "command_guardrails：action=rewrite 时必须提供 replacement",
  })
  .refine(
    (rule) => {
      // 正则必须在加载期可编译，避免把非法规则带进运行时才炸
      try {
        new RegExp(rule.pattern, rule.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "command_guardrails：pattern 不是合法正则" },
  );

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
    // 场景生成（scene 阶段）内部并发度，范围 1-8；与 max_concurrent_stage 解耦
    scene_concurrency: z.number().int().min(1).max(8),
    minimum_free_disk_gb: z.number().nonnegative(),
  }),
  assets: z
    .object({
      // 单个用户上传文件最大字节数。
      max_upload_bytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024 * 1024),
      // 单个项目用户上传文件总量最大字节数。
      max_project_upload_bytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024 * 1024),
      // 单条用户消息可引用资产数。
      max_message_refs: z.number().int().min(1).max(32),
    })
    .refine((value) => value.max_project_upload_bytes >= value.max_upload_bytes, {
      message: "assets.max_project_upload_bytes 必须不小于 max_upload_bytes",
    })
    // 缺省值保证旧配置文件与单元测试里手写的 config 对象仍然可用
    .default({
      max_upload_bytes: 25 * 1024 * 1024,
      max_project_upload_bytes: 512 * 1024 * 1024,
      max_message_refs: 8,
    }),
  tools: z.object({
    chromium_path: z.string(),
    ffmpeg_path: z.string(),
    ffprobe_path: z.string(),
  }),
  agent: z.object({
    // 是否向 agent 放开 bash / write / edit
    allow_shell_write_edit: z.boolean(),
    // 是否向 Web 推送并持久化模型思考过程（reasoning）
    show_thinking: z.boolean(),
    // 工具输出预览字符上限，范围 256-65536（超出截断，全文不落库）
    tool_output_preview_chars: z.number().int().min(256).max(65536),
    // 相同（工具+参数）连续失败达此次数后硬熔断，范围 0-20；0 表示关闭熔断
    tool_failure_circuit_breaker: z.number().int().min(0).max(20),
    // bash 命令预检护栏规则列表；空数组表示不做任何改写与拦截（见 commandGuardrailSchema）
    command_guardrails: z.array(commandGuardrailSchema),
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
