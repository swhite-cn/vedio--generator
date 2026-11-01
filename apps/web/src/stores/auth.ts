/**
 * 鉴权 store（见 Web 专题 §7.1）：token、当前用户、登录/注册/登出/改密动作，
 * 同时作为路由守卫的数据源。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiRequest, clearToken, getToken, setToken } from "../services/api";

/** 服务端对外用户视图（`GET /api/auth/me`、登录/注册响应中的 `user`）。 */
export interface ApiPublicUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  must_change_password: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

/** 前端使用的当前用户模型（字段转为 camelCase）。 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
}

/**
 * 把服务端用户视图转为前端模型（`role` 收敛为 `admin`/`user`，其余回落 `user`）。
 * @param user 服务端用户视图
 * @returns 前端用户模型
 */
function toAuthUser(user: ApiPublicUser): AuthUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role === "admin" ? "admin" : "user",
    mustChangePassword: user.must_change_password === true,
  };
}

export const useAuthStore = defineStore("auth", () => {
  /** 当前 access token，与 `localStorage["vf.token"]` 保持同步。 */
  const token = ref<string | null>(getToken());
  /** 当前登录用户；未登录或未加载时为 null。 */
  const me = ref<AuthUser | null>(null);

  /**
   * 登录：调用登录接口并落 token 与用户信息。
   * @param username 用户名
   * @param password 密码
   * @returns 登录后的当前用户
   */
  async function login(username: string, password: string): Promise<AuthUser> {
    const result = await apiRequest<{ token: string; user: ApiPublicUser }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
      auth: false,
    });
    setToken(result.token);
    token.value = result.token;
    me.value = toAuthUser(result.user);
    console.info("[web-store] 登录成功");
    return me.value;
  }

  /**
   * 注册：注册成功后用同一凭据自动登录（注册接口不返回 token）。
   * @param username 用户名
   * @param password 密码
   * @param displayName 显示名（可选）
   * @returns 登录后的当前用户
   */
  async function register(
    username: string,
    password: string,
    displayName?: string,
  ): Promise<AuthUser> {
    await apiRequest<{ user: ApiPublicUser }>("/api/auth/register", {
      method: "POST",
      body: { username, password, displayName },
      auth: false,
    });
    console.info("[web-store] 注册成功，尝试自动登录");
    return login(username, password);
  }

  /**
   * 拉取当前用户信息（登录后初始化、改密后刷新、路由守卫）。
   * @returns 当前用户
   */
  async function fetchMe(): Promise<AuthUser> {
    const result = await apiRequest<{ user: ApiPublicUser }>("/api/auth/me");
    me.value = toAuthUser(result.user);
    return me.value;
  }

  /**
   * 修改密码，成功后重新拉取用户信息以刷新 `mustChangePassword`。
   * @param currentPassword 当前密码
   * @param newPassword 新密码
   */
  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiRequest("/api/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    await fetchMe();
    console.info("[web-store] 密码已修改");
  }

  /**
   * 登出：调用登出接口（服务端为无状态 no-op），清除本地 token 与用户信息。
   */
  async function logout(): Promise<void> {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn("[web-store] 登出接口调用失败，仍清理本地登录态", error);
    }
    clearToken();
    token.value = null;
    me.value = null;
  }

  return { token, me, login, register, fetchMe, changePassword, logout };
});
