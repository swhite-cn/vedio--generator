import { join } from "node:path";
import { validateEnvironment } from "../../../scripts/verify-windows-environment.mjs";
import { loadLocalEnv, loadSystemConfig, type SystemConfig } from "@videoforge/pipeline";

/** 单条体检结果；`status` 取值与 `validateEnvironment` 保持一致。 */
export interface DoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

/** 火山方舟 Agent Plan 专用基础地址；被改成 `/api/v3` 会产生额外费用（见设计文档 §3.5、配置约定）。 */
const ARK_PLAN_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

/** `chat_model` 的占位值；仍为该值说明尚未在本机配置中填写真实模型 ID。 */
const PLACEHOLDER_CHAT_MODEL = "PLEASE_FILL_CHAT_MODEL_ID";

/**
 * 配置类体检（纯函数，无 IO，便于单测）：检查 `chat_model` 占位、`ARK_API_KEY` 存在、
 * ark `base_url` 未被误改、`storage_root` 可解析。
 * @param options.config 已加载的系统配置（`loadSystemConfig` 返回值）
 * @param options.env 环境变量表（用于读取 `ARK_API_KEY`）
 * @returns 按固定顺序排列的配置检查结果数组
 */
export function evaluateConfigChecks(options: {
  config: SystemConfig;
  env: NodeJS.ProcessEnv;
}): DoctorCheck[] {
  const { config, env } = options;
  const ark = config.engines.endpoints.ark;
  const checks: DoctorCheck[] = [];

  // 1) chat_model 是否仍为占位值
  checks.push(
    ark.chat_model === PLACEHOLDER_CHAT_MODEL
      ? {
          name: "ark.chat_model",
          status: "FAIL",
          message: `chat_model 仍为占位值 ${PLACEHOLDER_CHAT_MODEL}，请在 config/system.local.yaml 填写真实模型 ID`,
        }
      : { name: "ark.chat_model", status: "PASS", message: `chat_model = ${ark.chat_model}` },
  );

  // 2) ARK_API_KEY 是否存在（去空格后非空）
  const arkApiKey = env.ARK_API_KEY?.trim();
  checks.push(
    arkApiKey
      ? { name: "ark.api_key", status: "PASS", message: "已检测到 ARK_API_KEY" }
      : {
          name: "ark.api_key",
          status: "FAIL",
          message: "缺少 ARK_API_KEY：请在环境变量或仓库根目录 .env.local 中配置",
        },
  );

  // 3) ark base_url 是否被误改（严禁 /api/v3）
  checks.push(
    ark.base_url === ARK_PLAN_BASE_URL
      ? { name: "ark.base_url", status: "PASS", message: `base_url = ${ark.base_url}` }
      : {
          name: "ark.base_url",
          status: "FAIL",
          message: `ark base_url 必须为 ${ARK_PLAN_BASE_URL}；改为 /api/v3 会产生额外费用`,
        },
  );

  // 4) storage_root 是否可解析（非空）
  const storageRoot = config.runtime.storage_root?.trim();
  checks.push(
    storageRoot
      ? { name: "storage_root", status: "PASS", message: `storage_root = ${storageRoot}` }
      : { name: "storage_root", status: "FAIL", message: "storage_root 未配置或为空" },
  );

  return checks;
}

/**
 * 执行本机依赖 + 配置体检，返回退出码（存在 FAIL 返回 1，否则 0）。
 * 设计文档 §3.5：doctor 移除 Python 校验，新增 `chat_model` 占位、`ARK_API_KEY` 存在、
 * `base_url` 误改三类配置校验；本命令不向 stdout 写任何内容（诊断走 stderr）。
 * @param rootDir 仓库根目录
 * @param options.validateEnvironment 环境探针（默认取 scripts/verify-windows-environment.mjs 的
 *   `validateEnvironment`；测试可注入以避免真实探测）
 * @param options.env 环境变量表（默认加载 `.env.local` 后取 `process.env`；显式提供时不再调用
 *   `loadLocalEnv`，避免测试污染全局环境）
 * @returns 进程退出码
 */
export async function runDoctor(
  rootDir: string,
  options: {
    validateEnvironment?: typeof validateEnvironment;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const probe = options.validateEnvironment ?? validateEnvironment;
  let env: NodeJS.ProcessEnv;
  if (options.env) {
    env = options.env;
  } else {
    // 未注入 env 时加载 .env.local，使 ARK_API_KEY 等本机密钥可被读取
    loadLocalEnv(rootDir);
    env = process.env;
  }

  const config = loadSystemConfig({ rootDir });
  const envResults = (await probe({
    rootDir,
    configPath: join(rootDir, "config/system.local.yaml"),
  })) as DoctorCheck[];

  // 设计文档 §3.5：doctor 移除 Python 校验
  const checks: DoctorCheck[] = [
    ...envResults.filter((item) => item.name !== "python"),
    ...evaluateConfigChecks({ config, env }),
  ];

  for (const check of checks) {
    console.info(`[doctor] ${check.name}: ${check.status} - ${check.message}`);
  }
  const failed = checks.filter((item) => item.status === "FAIL");
  console.info(`[doctor] completed: ${failed.length ? "FAILED" : "PASS"}`);
  return failed.length ? 1 : 0;
}
