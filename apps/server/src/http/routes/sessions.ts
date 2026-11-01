import type { FastifyInstance } from "fastify";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, extractActor, requireActor } from "../auth-hook.js";
import { EVENT_TICKET_TTL_MS, signEventTicket, verifyEventTicket } from "../event-ticket.js";
import { getSseHeaders, startHeartbeat, writeSseEvent } from "../sse.js";
import { appendMessage } from "../../db/repositories/message-repository.js";
import { getSession } from "../../db/repositories/session-repository.js";

/**
 * 会话路由（见设计文档 §4.2、§4.4、§8.3 事件层）。
 * - 普通路由需 Bearer 鉴权；
 * - SSE 路由支持 `?ticket=<票据>` 或 `Authorization: Bearer <access token>`，且必须在建立连接前完成会话归属校验。
 */

/**
 * 注册会话路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerSessionRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 发送用户消息：先归属校验并落库，再交给对话端口处理。 */
  app.post("/api/sessions/:id/messages", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length === 0) {
      throw new VideoForgeError("CONFIG_INVALID", "消息内容不能为空");
    }
    if (!getSession(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `会话不存在：${id}`);
    }

    const message = appendMessage(deps.db, actor, {
      sessionId: id,
      role: "user",
      payload: { role: "user", content: text },
    });
    await deps.chat.send(actor, id, message);
    reply.code(202);
    return { message };
  });

  /** 中断当前自由对话轮。 */
  app.post("/api/sessions/:id/abort", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getSession(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `会话不存在：${id}`);
    }
    deps.chat.abort(actor, id);
    reply.code(202);
    return { ok: true };
  });

  /** 签发 SSE 短时票据（需 Bearer + 会话归属校验）。 */
  app.post(
    "/api/sessions/:id/events-ticket",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      if (!getSession(deps.db, actor, id)) {
        throw new VideoForgeError("AUTH_FORBIDDEN", `会话不存在：${id}`);
      }
      const ticket = signEventTicket(app, actor, id);
      reply.code(200);
      return { ticket, expiresInMs: EVENT_TICKET_TTL_MS };
    },
  );

  /**
   * SSE 事件流：本路由**不能**挂 `createAuthPreHandler`（可能只带 `?ticket=`），
   * 故在处理函数内手工完成鉴权与会话归属校验（§8.3 事件层：不允许连接建立后再校验）。
   */
  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id: sessionId } = request.params as { id: string };

    // 1. 鉴权顺序：优先 Authorization，其次 ?ticket=
    let actor: Actor;
    if (request.headers.authorization) {
      actor = extractActor(app, request.headers.authorization);
    } else {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const ticket = query["ticket"];
      if (typeof ticket === "string" && ticket.length > 0) {
        actor = verifyEventTicket(app, ticket, sessionId);
      } else {
        throw new VideoForgeError("AUTH_INVALID", "缺少凭据");
      }
    }

    // 2. 建连前校验会话归属
    if (!getSession(deps.db, actor, sessionId)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `会话不存在：${sessionId}`);
    }

    // 3. 夺回连接控制权并写出 SSE 头
    reply.hijack();
    const headers = getSseHeaders();
    for (const [key, value] of Object.entries(headers)) {
      reply.raw.setHeader(key, value);
    }
    reply.raw.writeHead(200, headers);

    // 4. 依据 Last-Event-ID 续传
    const lastEventIdHeader = request.headers["last-event-id"];
    const lastEventId = typeof lastEventIdHeader === "string" ? lastEventIdHeader : undefined;
    const { events, resync } = deps.eventBus.replay(sessionId, lastEventId);
    if (resync) {
      writeSseEvent(reply, { type: "resync", payload: { reason: "buffer-miss" } });
    }
    for (const event of events) {
      writeSseEvent(reply, { id: event.id, type: event.type, payload: event.payload });
    }

    // 5. 订阅后续事件 + 心跳
    const unsubscribe = deps.eventBus.subscribe(sessionId, (event) => {
      writeSseEvent(reply, { id: event.id, type: event.type, payload: event.payload });
    });
    const stopHeartbeat = startHeartbeat(reply);

    // 6. 连接关闭时释放订阅与心跳
    request.raw.on("close", () => {
      unsubscribe();
      stopHeartbeat();
    });

    // 7. hijack 后不得再 reply.send
    return reply;
  });
}
