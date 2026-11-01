import type { SystemConfig } from "@videoforge/pipeline";
import type { Actor, Message } from "@videoforge/shared";
import type { EventBus } from "./event-bus.js";
import type { WorkflowEngine } from "../workflow/engine.js";

/**
 * HTTP 路由层运行期依赖契约（见设计文档 §4.2）。
 * 由 `app.ts` 组装真实实现（P9-D）；集成测试注入假 `workflow` / `chat` 以隔离内核。
 */

/** 会话对话端口：把用户消息交给 agent 处理、并支持中断当前轮（生产实现见 P9-D；集成测试注入假实现）。 */
export interface ChatPort {
  /** 处理一条已落库的用户消息（流式增量经事件总线推送）。 */
  send(actor: Actor, sessionId: string, message: Message): Promise<void>;
  /** 中断当前自由对话轮（无活跃轮时静默）。 */
  abort(actor: Actor, sessionId: string): void;
}

/** HTTP 路由层依赖（由 app.ts 组装，测试可注入假实现）。 */
export interface HttpDeps {
  db: any;
  config: SystemConfig;
  rootDir: string;
  storageRoot: string;
  eventBus: EventBus;
  workflow: WorkflowEngine;
  chat: ChatPort;
}
