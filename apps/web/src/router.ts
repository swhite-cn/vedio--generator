/**
 * 路由表与全局前置守卫（Web 专题 §3.1、§3.2）。
 *
 * 已登记视图：`/login`、`/` 重定向、`/capabilities`、`/projects`、
 * `/projects/:id`（工作台）、`/runs/:id/trace`、
 * `/settings`、`/admin`（`requiresAdmin`）。
 */
import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "./stores/auth";
import { resolveNavigation } from "./router-guard";
import LoginView from "./views/LoginView.vue";
import CapabilitiesView from "./views/CapabilitiesView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import WorkbenchView from "./views/WorkbenchView.vue";
import StoryboardEditorView from "./views/StoryboardEditorView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import RunTraceView from "./views/RunTraceView.vue";
import AdminView from "./views/AdminView.vue";
import SettingsView from "./views/SettingsView.vue";
import AssetsView from "./views/AssetsView.vue";
import ComponentsView from "./views/ComponentsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginView, meta: { public: true, layout: "blank" } },
    // 能力中心为默认首页（方案 §8.4）；旧路径 /capabilities 重定向保留兼容
    { path: "/", component: CapabilitiesView, meta: { breadcrumb: ["能力中心"] } },
    { path: "/capabilities", redirect: "/" },
    { path: "/projects", component: ProjectsView, meta: { breadcrumb: ["项目"] } },
    // 工作台：与其他页面共用侧栏 + 顶栏外壳（方案 §8.3）
    { path: "/projects/:id", component: WorkbenchView, meta: { breadcrumb: ["项目", "工作台"] } },
    // 分镜时间轴编辑器（方案 §8.4 第 6 页）
    {
      path: "/projects/:id/storyboard",
      component: StoryboardEditorView,
      meta: { breadcrumb: ["项目", "分镜编辑器"] },
    },
    // Run 详情（方案 §8.4 第 9 页）
    {
      path: "/projects/:id/runs/:runId",
      component: RunDetailView,
      meta: { breadcrumb: ["项目", "Run 详情"] },
    },
    // 旧 Trace 路由 301 到 Run 详情（T307）
    {
      path: "/runs/:id/trace",
      component: RunTraceView,
      meta: { breadcrumb: ["项目", "Run 详情"] },
    },
    { path: "/settings", component: SettingsView, meta: { breadcrumb: ["设置"] } },
    { path: "/admin", component: AdminView, meta: { requiresAdmin: true, breadcrumb: ["管理"] } },
    // 素材库 / 组件库（方案 §8.4 第 7/8 页）
    { path: "/assets", component: AssetsView, meta: { breadcrumb: ["素材库"] } },
    { path: "/components", component: ComponentsView, meta: { breadcrumb: ["组件库"] } },
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
