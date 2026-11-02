import { apiRequest } from "./api";

/**
 * 媒体票据获取（服务端 `POST /api/media/ticket`，见 `apps/server/src/http/media-ticket.ts`）。
 *
 * 浏览器原生 `<img>` / `<audio>` / `<video>` / 新标签页无法携带 `Authorization` 头，
 * 故媒体地址统一附加 `?ticket=`。票据有效期 30 分钟，这里按「提前 60 秒过期」缓存，
 * 避免页面内每个媒体元素各发一次签发请求。
 */

/** 缓存条目：票据与其本地失效时间戳。 */
let cache: { ticket: string; expiresAt: number } | null = null;

/** 正在进行的签发请求（并发调用复用同一个 Promise）。 */
let inflight: Promise<string> | null = null;

/**
 * 获取可用的媒体票据（命中缓存时不发请求）。
 * @param force 是否强制重新签发（缓存过期或服务端拒绝时使用）
 * @returns 已签名的票据字符串
 * @throws ApiError 签发失败时透传服务端错误
 */
export async function getMediaTicket(force = false): Promise<string> {
  if (!force && cache && cache.expiresAt > Date.now()) {
    return cache.ticket;
  }
  if (inflight) {
    return inflight;
  }

  const request = apiRequest<{ ticket: string; expiresInMs: number }>("/api/media/ticket", {
    method: "POST",
  }).then((result) => {
    // 提前 60 秒失效，避免媒体加载临界过期
    const ttl = Math.max(result.expiresInMs - 60_000, 0);
    cache = { ticket: result.ticket, expiresAt: Date.now() + ttl };
    return result.ticket;
  });

  inflight = request;
  try {
    return await request;
  } finally {
    inflight = null;
  }
}

/**
 * 清空本地票据缓存（登出或收到 401 时调用）。
 */
export function clearMediaTicket(): void {
  cache = null;
}
