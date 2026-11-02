import type { ProjectAsset } from "@videoforge/shared";

/**
 * 将本轮被引用的资产转换为 Agent 可审计的受限上下文。
 * @param assets 当前消息显式引用的项目资产
 * @returns 可附加到用户请求前的纯文本上下文
 */
export function buildAssetContext(assets: ProjectAsset[]): string {
  if (assets.length === 0) return "";
  return [
    "## 当前消息引用的项目资产",
    "只可读取以下资产及当前项目受控目录；不得读取仓库、配置或 .env.local。",
    ...assets.map(
      (asset) =>
        `- [${asset.id}] ${asset.kind} ${asset.label} (${asset.relative_path}, ${asset.mime_type}, ${asset.size_bytes} bytes)`,
    ),
  ].join("\n");
}
