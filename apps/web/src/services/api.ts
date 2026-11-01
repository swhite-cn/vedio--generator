/**
 * 统一 REST API 客户端（见 Web 专题 §1.2、§2.4、§8）。
 *
 * 约定：
 * - 一律使用相对路径（`/api/...`），不硬编码主机名与端口，`VITE_API_BASE` 仅作部署覆盖；
 * - access token 存 `localStorage["vf.token"]`，`auth !== false` 时自动注入 `Authorization` 头；
 * - 服务端错误响应体统一为 `{ error: { code, message } }`，此处抛出携带 `code`/`status` 的错误对象；
 * - 收到 401 时清 token 并跳转登录页（登录后回跳）。
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

/** access token 的 localStorage 键（设计唯一约定）。 */
const TOKEN_KEY = "vf.token";

/** 网络层异常（非业务码）使用的错误码。 */
const NETWORK_ERROR_CODE = "NETWORK_ERROR";

/** 网络层异常提示文案。 */
const NETWORK_ERROR_MESSAGE = "网络异常，请检查服务是否在线";

/** 统一 API 错误对象：在标准 Error 上附加业务错误码与 HTTP 状态码。 */
export interface ApiError extends Error {
  /** 服务端业务错误码（如 `AUTH_INVALID`）；网络异常为 `NETWORK_ERROR`。 */
  code: string;
  /** HTTP 状态码；网络异常为 0。 */
  status: number;
}

/** `apiRequest` 的可选参数。 */
export interface ApiRequestOptions {
  /** HTTP 方法，缺省 `GET`。 */
  method?: string;
  /** 请求体（会被 `JSON.stringify`），缺省不带请求体。 */
  body?: unknown;
  /** 是否注入 Bearer token，缺省 `true`；登录/注册等公开接口传 `false`。 */
  auth?: boolean;
}

/**
 * 读取当前 access token。
 * @returns token 字符串；不存在或存储不可用时返回 null
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * 写入 access token。
 * @param token 待保存的 token
 */
export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 存储不可用（隐私模式等）时静默降级，仅影响下次刷新的会话保持。
  }
}

/**
 * 清除 access token。
 */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 同上，静默降级。
  }
}

/**
 * 构造统一 API 错误对象。
 * @param code 业务错误码
 * @param message 错误文案
 * @param status HTTP 状态码
 * @returns 携带 code/status 的 Error
 */
function createApiError(code: string, message: string, status: number): ApiError {
  const error = new Error(message) as ApiError;
  error.code = code;
  error.status = status;
  return error;
}

/**
 * 401 处理：清 token 并跳登录页（携带回跳目标），已在登录页则不重复跳转。
 */
function handleUnauthorized(): void {
  clearToken();
  if (typeof window === "undefined" || !window.location) {
    return;
  }
  const { pathname, search } = window.location;
  if (pathname === "/login") {
    return;
  }
  const target = `${pathname}${search}`;
  console.warn("[web] 登录态失效，跳转登录页");
  window.location.assign(`/login?redirect=${encodeURIComponent(target)}`);
}

/**
 * 调用后端 JSON API。
 * @param path API 路径（相对，如 `/api/projects`）
 * @param options 请求选项（方法、请求体、是否鉴权）
 * @returns 解析后的响应体
 * @throws ApiError 非 2xx 时抛出携带 `code`/`message`/`status` 的错误；网络异常抛出 `NETWORK_ERROR`
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth) {
    const token = getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw createApiError(NETWORK_ERROR_CODE, NETWORK_ERROR_MESSAGE, 0);
  }

  const text = await response.text();
  let data: unknown;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const errorBody = (data as { error?: { code?: unknown; message?: unknown } } | undefined)
      ?.error;
    const code = typeof errorBody?.code === "string" ? errorBody.code : "UNKNOWN";
    const message =
      typeof errorBody?.message === "string" ? errorBody.message : `请求失败（${response.status}）`;
    if (response.status === 401) {
      handleUnauthorized();
    }
    throw createApiError(code, message, response.status);
  }

  return data as T;
}

/**
 * 把任意错误格式化为用户可见文案。
 * 业务错误统一为「操作失败：{message}（{code}）」；非业务错误（网络异常）返回固定提示。
 * @param error 捕获到的错误
 * @returns 用户可见的错误文案
 */
export function formatApiError(error: unknown): string {
  const candidate = error as Partial<ApiError> | undefined;
  if (
    candidate &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    candidate.code !== NETWORK_ERROR_CODE
  ) {
    return `操作失败：${candidate.message}（${candidate.code}）`;
  }
  return NETWORK_ERROR_MESSAGE;
}
