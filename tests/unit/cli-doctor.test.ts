import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateConfigChecks } from "../../apps/cli/src/doctor";
import { loadSystemConfig } from "../../packages/pipeline/src/config";

/** 仓库根目录（测试从仓库根运行，`config/default.yaml` 在此可见）。 */
const ROOT_DIR = resolve(process.cwd());

/** 合法的 ark 基础地址（Agent Plan 专用路径）。 */
const ARK_PLAN_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

/**
 * 以默认配置为底、叠加覆盖项构造测试用系统配置。
 * @param override 深度覆盖片段
 * @returns 类型化系统配置
 */
function makeConfig(override: Record<string, unknown>) {
  return loadSystemConfig({ rootDir: ROOT_DIR, override });
}

/** 构造一份合规的 override（chat_model 非占位、base_url 正确、storage_root 非空）。 */
function compliantOverride(): Record<string, unknown> {
  return {
    runtime: { storage_root: "storage" },
    engines: { endpoints: { ark: { chat_model: "real-chat-model", base_url: ARK_PLAN_BASE_URL } } },
  };
}

describe("doctor.evaluateConfigChecks（§3.5 配置类体检）", () => {
  it("chat_model 仍为占位值时有 FAIL", () => {
    const config = makeConfig({
      ...compliantOverride(),
      engines: {
        endpoints: {
          ark: { chat_model: "PLEASE_FILL_CHAT_MODEL_ID", base_url: ARK_PLAN_BASE_URL },
        },
      },
    });
    const checks = evaluateConfigChecks({ config, env: { ARK_API_KEY: "test-key" } });
    expect(checks.some((item) => item.status === "FAIL")).toBe(true);
    expect(checks.find((item) => item.name === "ark.chat_model")?.status).toBe("FAIL");
  });

  it("缺少 ARK_API_KEY 时有 FAIL", () => {
    const checks = evaluateConfigChecks({ config: makeConfig(compliantOverride()), env: {} });
    expect(checks.find((item) => item.name === "ark.api_key")?.status).toBe("FAIL");
  });

  it("base_url 被误改为 /api/v3 时有 FAIL，且说明会产生额外费用", () => {
    const config = makeConfig({
      ...compliantOverride(),
      engines: {
        endpoints: {
          ark: {
            chat_model: "real-chat-model",
            base_url: "https://ark.cn-beijing.volces.com/api/v3",
          },
        },
      },
    });
    const checks = evaluateConfigChecks({ config, env: { ARK_API_KEY: "test-key" } });
    const baseUrlCheck = checks.find((item) => item.name === "ark.base_url");
    expect(baseUrlCheck?.status).toBe("FAIL");
    expect(baseUrlCheck?.message).toContain("/api/v3");
  });

  it("全部合规时无 FAIL", () => {
    const checks = evaluateConfigChecks({
      config: makeConfig(compliantOverride()),
      env: { ARK_API_KEY: "test-key" },
    });
    expect(checks.filter((item) => item.status === "FAIL")).toHaveLength(0);
  });
});
