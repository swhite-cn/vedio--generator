/**
 * 路由守卫决策纯函数（Web 专题 §3.2）。
 *
 * 抽出为纯函数以便单元测试直接覆盖四类分支；`router.ts` 的 `beforeEach` 只负责
 * 装载 `auth` store 数据后调用本函数。
 */

/** 守卫需要的最小用户信息。 */
export interface GuardUser {
  /** 是否必须改密（首次登录/被重置密码）。 */
  mustChangePassword?: boolean;
  /** 用户角色（`admin` / `user`），用于仅 admin 页面的拦截。 */
  role?: string;
}

/** `resolveNavigation` 的输入。 */
export interface NavigationInput {
  /** 是否已登录（含已加载的用户信息）。 */
  isAuthenticated: boolean;
  /** 当前用户（未加载时为 null）。 */
  me: GuardUser | null;
  /** 目标路径（含查询串，即 `to.fullPath`）。 */
  toPath: string;
  /** 目标路由是否仅 admin 可见（来自 `to.meta.requiresAdmin`），缺省 false。 */
  requiresAdmin?: boolean;
}

/** 决策结果：`{ path, query }` 表示重定向；`null` 表示放行。 */
export interface NavigationDecision {
  /** 重定向目标路径。 */
  path: string;
  /** 重定向查询参数。 */
  query?: Record<string, string>;
}

/** 登录页路径。 */
const LOGIN_PATH = "/login";
/** 个人设置页路径（首次改密强制落地）。 */
const SETTINGS_PATH = "/settings";
/** 登录后的默认落地页。 */
const DEFAULT_PATH = "/projects";

/**
 * 判断路径是否命中某具体页（精确匹配或带查询串）。
 * @param toPath 目标路径
 * @param path 目标页路径
 * @returns 命中返回 true
 */
function matchesPath(toPath: string, path: string): boolean {
  return toPath === path || toPath.startsWith(`${path}?`);
}

/**
 * 依据登录态、用户信息与目标路径解析导航决策。
 * 分支：未登录访问非公开页 → 跳登录并带 redirect；已登录访问登录页 → 跳默认页；
 * 已登录且需改密但目标非 `/settings` → 强制跳 `/settings?force=1`；
 * 已登录但访问仅 admin 页面而角色非 admin → 跳 `/projects`（第二道拦截，见 Web 专题 §3.2）；其余放行。
 * @param input 导航输入
 * @returns 重定向决策或 null（放行）
 */
export function resolveNavigation(input: NavigationInput): NavigationDecision | null {
  const { isAuthenticated, me, toPath, requiresAdmin } = input;
  const isLoginPage = matchesPath(toPath, LOGIN_PATH);

  if (!isAuthenticated) {
    return isLoginPage ? null : { path: LOGIN_PATH, query: { redirect: toPath } };
  }

  if (isLoginPage) {
    return { path: DEFAULT_PATH, query: {} };
  }

  if (me?.mustChangePassword === true && !matchesPath(toPath, SETTINGS_PATH)) {
    return { path: SETTINGS_PATH, query: { force: "1" } };
  }

  // 仅 admin 页面：普通用户被守卫拦截跳回默认页（第一道是菜单项不渲染）
  if (requiresAdmin === true && me?.role !== "admin") {
    return { path: DEFAULT_PATH, query: {} };
  }

  return null;
}
