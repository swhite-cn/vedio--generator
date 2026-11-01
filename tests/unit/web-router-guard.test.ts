/**
 * 路由守卫决策纯函数单测（Web 专题 §3.2）。
 *
 * 覆盖五类分支：未登录跳登录并带 redirect、已登录访问 /login 跳 /projects、
 * mustChangePassword 强制跳 /settings?force=1、非 admin 访问仅 admin 页跳 /projects、其余放行。
 */
import { describe, expect, test } from "vitest";
import { resolveNavigation } from "../../apps/web/src/router-guard";

describe("resolveNavigation", () => {
  test("redirects an anonymous user to login and remembers the target", () => {
    expect(resolveNavigation({ isAuthenticated: false, me: null, toPath: "/projects" })).toEqual({
      path: "/login",
      query: { redirect: "/projects" },
    });
  });

  test("keeps the query string when redirecting an anonymous user", () => {
    expect(
      resolveNavigation({ isAuthenticated: false, me: null, toPath: "/projects?tab=done" }),
    ).toEqual({ path: "/login", query: { redirect: "/projects?tab=done" } });
  });

  test("allows an anonymous user to stay on the login page", () => {
    expect(resolveNavigation({ isAuthenticated: false, me: null, toPath: "/login" })).toBeNull();
    expect(
      resolveNavigation({
        isAuthenticated: false,
        me: null,
        toPath: "/login?redirect=%2Fprojects",
      }),
    ).toBeNull();
  });

  test("moves an authenticated user away from the login page to the default page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { mustChangePassword: false },
        toPath: "/login",
      }),
    ).toEqual({ path: "/projects", query: {} });
  });

  test("forces a user who must change password to the settings page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { mustChangePassword: true },
        toPath: "/capabilities",
      }),
    ).toEqual({ path: "/settings", query: { force: "1" } });
  });

  test("does not loop when the forced user is already on the settings page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { mustChangePassword: true },
        toPath: "/settings?force=1",
      }),
    ).toBeNull();
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { mustChangePassword: true },
        toPath: "/settings",
      }),
    ).toBeNull();
  });

  test("lets a normal authenticated user through", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { mustChangePassword: false },
        toPath: "/projects",
      }),
    ).toBeNull();
  });

  test("lets an authenticated user through even before me is loaded", () => {
    expect(resolveNavigation({ isAuthenticated: true, me: null, toPath: "/projects" })).toBeNull();
  });

  test("lets an admin user open an admin-only page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { role: "admin", mustChangePassword: false },
        toPath: "/admin",
        requiresAdmin: true,
      }),
    ).toBeNull();
  });

  test("redirects a non-admin user away from an admin-only page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { role: "user", mustChangePassword: false },
        toPath: "/admin",
        requiresAdmin: true,
      }),
    ).toEqual({ path: "/projects", query: {} });
  });

  test("redirects a user whose role is not loaded away from an admin-only page", () => {
    expect(
      resolveNavigation({ isAuthenticated: true, me: null, toPath: "/admin", requiresAdmin: true }),
    ).toEqual({ path: "/projects", query: {} });
  });

  test("lets a non-admin user through a non-admin page", () => {
    expect(
      resolveNavigation({
        isAuthenticated: true,
        me: { role: "user", mustChangePassword: false },
        toPath: "/settings",
      }),
    ).toBeNull();
  });
});
