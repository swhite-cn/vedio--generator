import { CONTRACT_VERSION_V2, VideoForgeError } from "@videoforge/shared";

/**
 * 契约版本与存量项目迁移提示（T504）。
 *
 * legacy 场景/渲染通道已在 v2 重构（T501）中整体移除，因此契约版本非 v2 的
 * 存量项目（`projects.contract_version = '1.0'`）**无法续跑**：任何 run 都会在
 * scene 阶段因缺少 v2 产物而失败。这里集中提供统一的判定与可执行迁移提示，
 * 由 HTTP 层（发起 run 前拦截）与 CLI（`project:verify` 输出）共用，避免文案漂移。
 */

/**
 * 生成存量（非 v2）项目的可执行迁移提示。
 * @param contractVersion 项目的契约版本（`projects.contract_version`），缺失时按 `1.0` 表述
 * @returns 面向用户的中文迁移提示
 */
export function legacyProjectMigrationHint(contractVersion: string | null | undefined): string {
  const version = contractVersion ?? "1.0";
  return (
    `该项目契约版本为 ${version}，legacy 场景/渲染通道已在 v2 重构中移除，无法续跑；` +
    "请用当前版本新建项目重新生成（新项目一律 v2 契约）。"
  );
}

/**
 * 判断项目契约版本是否可运行（当前仅支持 v2）。
 * @param contractVersion 项目的契约版本（`projects.contract_version`）
 * @returns v2 返回 true；其余（含缺省的 `1.0`）返回 false
 */
export function isRunnableContract(contractVersion: string | null | undefined): boolean {
  return contractVersion === CONTRACT_VERSION_V2;
}

/**
 * 断言项目可发起/续跑 run；非 v2 时抛 `CONFIG_INVALID` 并附带迁移提示。
 * @param contractVersion 项目的契约版本（`projects.contract_version`）
 * @throws VideoForgeError(`CONFIG_INVALID`) 契约版本非 v2
 */
export function assertProjectRunnable(contractVersion: string | null | undefined): void {
  if (!isRunnableContract(contractVersion)) {
    throw new VideoForgeError("CONFIG_INVALID", legacyProjectMigrationHint(contractVersion));
  }
}
