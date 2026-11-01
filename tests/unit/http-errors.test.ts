import { afterEach, describe, expect, test, vi } from "vitest";
// 测试文件位于仓库根 tests/，根 node_modules 在 pnpm 严格隔离下不暴露 fastify；
// 走 server 工作区本地实例解析（与 apps/server/src 内部 import 'fastify' 指向同一实例）。
import Fastify from "../../apps/server/node_modules/fastify/fastify.js";
import { VideoForgeError } from "@videoforge/shared";
import {
  ERROR_STATUS,
  INTERNAL_ERROR_CODE,
  NOT_FOUND_CODE,
  describeError,
  registerErrorHandler,
  resolveStatusCode,
  toErrorBody,
} from "../../apps/server/src/http/errors";

/**
 * HTTP 错误映射与统一错误处理单测（P9-A）。
 * 覆盖 `ERROR_STATUS` 映射、`describeError` 前缀剥离、`toErrorBody` / `resolveStatusCode`
 * 以及 `registerErrorHandler` 的错误处理器与 404 处理器（用 Fastify inject 验证）。
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ERROR_STATUS 映射（§4.5 + §8.3）", () => {
  test("逐条断言设计文档列出的错误码", () => {
    expect(ERROR_STATUS.AUTH_INVALID).toBe(401);
    expect(ERROR_STATUS.AUTH_FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.PROJECT_BUSY).toBe(409);
    expect(ERROR_STATUS.RUN_STATE_INVALID).toBe(409);
    expect(ERROR_STATUS.CONFIG_INVALID).toBe(400);
    expect(ERROR_STATUS.TOOL_UNAVAILABLE).toBe(500);
    expect(ERROR_STATUS.ADAPTER_FAILED).toBe(500);
    expect(ERROR_STATUS.ADAPTER_PROTOCOL_INVALID).toBe(500);
    // §8.3 额外明确 PATH_OUTSIDE_STORAGE → 403
    expect(ERROR_STATUS.PATH_OUTSIDE_STORAGE).toBe(403);
    // 文档未列，按内核失败归 500
    expect(ERROR_STATUS.QUALITY_BLOCKED).toBe(500);
    expect(ERROR_STATUS.EVENT_IMMUTABLE).toBe(500);
  });
});

describe("describeError", () => {
  test("剥离 `${code}: ` 前缀", () => {
    const error = new VideoForgeError("CONFIG_INVALID", "配置缺失");
    expect(describeError(error)).toBe("配置缺失");
  });

  test("message 不以该前缀开头时原样返回", () => {
    const error = new VideoForgeError("CONFIG_INVALID", "占位");
    error.message = "原始描述";
    expect(describeError(error)).toBe("原始描述");
  });
});

describe("toErrorBody", () => {
  test("VideoForgeError 输出稳定错误码与无前缀 message", () => {
    const body = toErrorBody(new VideoForgeError("AUTH_FORBIDDEN", "需要管理员权限"));
    expect(body).toEqual({ error: { code: "AUTH_FORBIDDEN", message: "需要管理员权限" } });
  });

  test("普通 Error 输出 INTERNAL_ERROR 且不泄漏原始 message", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = toErrorBody(new Error("数据库连接串 secret-token-abc 泄漏"));
    expect(body).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: "服务器内部错误" } });
    expect(JSON.stringify(body)).not.toContain("secret-token-abc");
    expect(errorSpy).toHaveBeenCalled();
  });

  test("非 Error 抛出值（字符串）同样归为 INTERNAL_ERROR", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = toErrorBody("随便抛的字符串");
    expect(body).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: "服务器内部错误" } });
    expect(JSON.stringify(body)).not.toContain("随便抛");
  });

  test("两个 HTTP 层补充错误码不是领域错误码（常量值）", () => {
    expect(INTERNAL_ERROR_CODE).toBe("INTERNAL_ERROR");
    expect(NOT_FOUND_CODE).toBe("NOT_FOUND");
  });
});

describe("resolveStatusCode", () => {
  test("按错误码返回状态码，普通 Error 归 500", () => {
    expect(resolveStatusCode(new VideoForgeError("AUTH_INVALID", "x"))).toBe(401);
    expect(resolveStatusCode(new VideoForgeError("CONFIG_INVALID", "x"))).toBe(400);
    expect(resolveStatusCode(new VideoForgeError("PROJECT_BUSY", "x"))).toBe(409);
    expect(resolveStatusCode(new VideoForgeError("PATH_OUTSIDE_STORAGE", "x"))).toBe(403);
    expect(resolveStatusCode(new Error("普通错误"))).toBe(500);
    expect(resolveStatusCode("字符串")).toBe(500);
  });
});

describe("registerErrorHandler（Fastify inject 集成）", () => {
  test("VideoForgeError 映射为对应状态码与响应体形状", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get("/boom", async () => {
      throw new VideoForgeError("AUTH_FORBIDDEN", "测试越权");
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/boom" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: "AUTH_FORBIDDEN", message: "测试越权" } });
    } finally {
      await app.close();
    }
  });

  test("未预期错误返回 500 且不泄漏原始 message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get("/crash", async () => {
      throw new Error("内部细节 abc-def");
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/crash" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: INTERNAL_ERROR_CODE, message: "服务器内部错误" },
      });
      expect(response.body).not.toContain("abc-def");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("未注册路由返回 404 + NOT_FOUND", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/does-not-exist" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: NOT_FOUND_CODE, message: "资源不存在" } });
    } finally {
      await app.close();
    }
  });
});
