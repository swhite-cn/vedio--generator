/** 系统稳定错误码，供 API、Worker 和 CLI 统一记录（见设计文档 §4.5）。 */
export type VideoForgeErrorCode =
  | "CONFIG_INVALID"
  | "TOOL_UNAVAILABLE"
  | "PATH_OUTSIDE_STORAGE"
  | "ADAPTER_FAILED"
  | "ADAPTER_PROTOCOL_INVALID"
  | "QUALITY_BLOCKED"
  | "EVENT_IMMUTABLE"
  // 新增错误码（见设计文档 §4.5）
  | "AUTH_INVALID" // 401：令牌缺失 / 过期 / 签名不符
  | "AUTH_FORBIDDEN" // 403：无权限、越权访问、注册关闭、保留用户名
  | "PROJECT_BUSY" // 409：项目已有活跃 run，租约冲突
  | "RUN_STATE_INVALID" // 409：非法 run 状态流转
  | "TOOL_COMMAND_BLOCKED" // bash 命令被配置护栏（agent.command_guardrails）拒绝
  | "TOOL_CIRCUIT_OPEN" // 相同工具+参数连续失败达阈值，熔断并拒绝后续相同调用
  | "ASSET_TYPE_UNSUPPORTED" // 400：上传文件类型不在白名单
  | "ASSET_TOO_LARGE" // 400：上传文件或项目上传总量超限
  | "ASSET_INVALID" // 400：资产路径、请求参数或文件内容非法
  | "ASSET_NOT_FOUND" // 404：当前项目中没有该资产
  | "ACTION_CONFIRMATION_REQUIRED" // 409：高影响 Agent 动作尚未获确认
  | "ACTION_NOT_CONFIRMABLE"; // 409：动作已终结或不属于当前 actor

/**
 * `runs.error_code` 在“进程重启导致运行中断”场景下的取值。
 * 注意：`INTERRUPTED` 不是 API 错误码，仅作为 `runs.error_code` 的值（见设计文档 §4.5、§6.5）。
 */
export const RUN_ERROR_INTERRUPTED = "INTERRUPTED";

/**
 * 创建带稳定错误码的业务异常。
 * @param code 稳定错误码
 * @param message 面向日志和调用方的错误信息
 */
export class VideoForgeError extends Error {
  public readonly code: VideoForgeErrorCode;

  constructor(code: VideoForgeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "VideoForgeError";
    this.code = code;
  }
}
