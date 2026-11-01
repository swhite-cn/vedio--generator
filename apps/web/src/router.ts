/**
 * 路由表与全局前置守卫（Web 专题 §3.1、§3.2）。
 *
 * 已登记视图：`/login`、`/` 重定向、`/capabilities`、`/projects`、
 * `/projects/:id`（工作台，`layout: "workbench"`）、`/runs/:id/trace`、
 * `/settings`、`/admin`（`requiresAdmin`）。
 */
import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "./stores/auth";
import { resolveNavigation } from "./router-guard";
import LoginView from "./views/LoginView.vue";
import CapabilitiesView from "./views/CapabilitiesView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import WorkbenchView from "./views/WorkbenchView.vue";
import RunTraceView from "./views/RunTraceView.vue";
import AdminView from "./views/AdminView.vue";
import SettingsView from "./views/SettingsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginView, meta: { public: true, layout: "blank" } },
    { path: "/", redirect: "/projects" },
    { path: "/capabilities", component: CapabilitiesView },
    { path: "/projects", component: ProjectsView },
    // 工作台：隐藏侧边栏为对话流让出宽度（Web 专题 §4）
    { path: "/projects/:id", component: WorkbenchView, meta: { layout: "workbench" } },
    { path: "/runs/:id/trace", component: RunTraceView },
    { path: "/settings", component: SettingsView },
    { path: "/admin", component: AdminView, meta: { requiresAdmin: true } },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 有 token 但未加载用户信息时先拉取（守卫的 me 数据源）
  if (auth.token && !auth.me) {
    try {
      await auth.fetchMe();
    } catch (error) {
      console.warn("[web] 守卫拉取当前用户失败，按未登录处理", error);
    }
  }

  const decision = resolveNavigation({
    isAuthenticated: Boolean(auth.token && auth.me),
    me: auth.me,
    toPath: to.fullPath,
    requiresAdmin: to.meta.requiresAdmin === true,
  });

  return decision ?? undefined;
});
