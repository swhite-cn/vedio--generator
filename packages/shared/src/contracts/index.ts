/**
 * 契约 v2 统一出口：内容层、时序层、视觉层、质量、主题、组件注册表。
 * 所有跨包/跨应用的契约类型与 zod schema 只从这里导出，避免多份定义漂移。
 */
export * from "./common.js";
export * from "./copy.js";
export * from "./timeline.js";
export * from "./scene-spec.js";
export * from "./quality.js";
export * from "./theme.js";
export * from "./component.js";
