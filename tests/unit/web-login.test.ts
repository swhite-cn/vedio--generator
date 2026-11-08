// @vitest-environment jsdom
/**
 * T302 登录页测试：结构（品牌区/无注册）、表单可访问性、提交与回跳、
 * 记住我语义、行内错误与「忘记密码」指引。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import LoginView from "../../apps/web/src/views/LoginView.vue";
import { useAuthStore, type AuthUser } from "../../apps/web/src/stores/auth";
import { STAGE_LABELS } from "../../apps/web/src/components/state-mapping";
import { clearToken, getToken, setToken } from "../../apps/web/src/services/api";

/** 登录成功后的用户夹具。 */
const USER: AuthUser = {
  id: "u-1",
  username: "tester",
  displayName: "测试用户",
  role: "user",
  mustChangePassword: false,
};

/** 构造指向登录页的内存路由（带 redirect 查询串）。 */
async function makeRouter(redirect?: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/login", component: { render: () => null } },
      { path: "/projects", component: { render: () => null } },
      { path: "/projects/:id", component: { render: () => null } },
    ],
  });
  const target = redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : "/login";
  await router.push(target);
  await router.isReady();
  return router;
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("登录页：结构（方案 §8.5 第 1 页）", () => {
  test("渲染品牌区 slogan、3 项特性与八阶段 chips", async () => {
    const router = await makeRouter();
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    expect(wrapper.find(".login-slogan").text()).toBe("把内容创作交给 Agent 流水线");
    expect(wrapper.findAll(".login-feature__title").map((node) => node.text())).toEqual([
      "一句一镜",
      "逐句字幕",
      "质检门禁",
    ]);
    // chips 与工作台阶段命名同源
    expect(wrapper.findAll(".login-stage").map((node) => node.text())).toEqual(
      Object.values(STAGE_LABELS),
    );
  });

  test("无公开注册入口：表单只有用户名与密码", async () => {
    const router = await makeRouter();
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    expect(wrapper.findAll(".login-form input")).toHaveLength(3); // 用户名 + 密码 + 记住我
    expect(wrapper.text()).not.toContain("确认密码");
    expect(wrapper.find(".login-footer").text()).toContain("不开放自助注册");
    expect(wrapper.find(".login-footer").text()).toContain("管理员");
  });

  test("可见标签通过 for/id 关联到输入框（可访问名称）", async () => {
    const router = await makeRouter();
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    const labels = wrapper.findAll(".login-label");
    expect(labels[0]!.attributes("for")).toBe("login-username");
    expect(labels[1]!.attributes("for")).toBe("login-password");
    expect(wrapper.find("#login-username").exists()).toBe(true);
    expect(wrapper.find("#login-password").attributes("type")).toBe("password");
    // 自动填充提示保证密码管理器可用
    expect(wrapper.find("#login-username").attributes("autocomplete")).toBe("username");
    expect(wrapper.find("#login-password").attributes("autocomplete")).toBe("current-password");
  });
});

describe("登录页：提交与回跳", () => {
  test("表单提交调用 login（含记住我）并回跳 redirect 目标", async () => {
    const router = await makeRouter("/projects/p-1");
    const replaceSpy = vi.spyOn(router, "replace");
    const auth = useAuthStore();
    const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(USER);
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("  tester  ");
    await wrapper.find("#login-password").setValue("secret-pass");
    await wrapper.find("form").trigger("submit");

    expect(loginSpy).toHaveBeenCalledWith("tester", "secret-pass", true);
    expect(replaceSpy).toHaveBeenCalledWith("/projects/p-1");
  });

  test("取消「记住我」时 login 收到 remember=false（token 仅本次会话）", async () => {
    const router = await makeRouter();
    const auth = useAuthStore();
    const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(USER);
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("tester");
    await wrapper.find("#login-password").setValue("secret-pass");
    await wrapper.find(".login-remember__box").setValue(false);
    await wrapper.find("form").trigger("submit");

    expect(loginSpy).toHaveBeenCalledWith("tester", "secret-pass", false);
  });

  test("无 redirect 时回跳默认项目列表", async () => {
    const router = await makeRouter();
    const replaceSpy = vi.spyOn(router, "replace");
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockResolvedValue(USER);
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("tester");
    await wrapper.find("#login-password").setValue("secret-pass");
    await wrapper.find("form").trigger("submit");

    expect(replaceSpy).toHaveBeenCalledWith("/projects");
  });
});

describe("登录页：token 存储语义（记住我）", () => {
  const TOKEN_KEY = "vf.token";

  test("记住我：token 落 localStorage，会话存储不残留", () => {
    setToken("t-persist", true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t-persist");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(getToken()).toBe("t-persist");
  });

  test("不记住我：token 落 sessionStorage，关闭浏览器即失效", () => {
    setToken("t-session", false);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("t-session");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(getToken()).toBe("t-session");
  });

  test("切换存储模式不残留旧副本；clearToken 清两侧", () => {
    setToken("t-old", true);
    setToken("t-new", false);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("t-new");

    clearToken();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(getToken()).toBeNull();
  });
});

describe("登录页：行内错误与提示", () => {
  test("AUTH_INVALID 显示行内错误、清空密码，不跳转", async () => {
    const router = await makeRouter();
    const replaceSpy = vi.spyOn(router, "replace");
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockRejectedValue(
      Object.assign(new Error("invalid"), { code: "AUTH_INVALID", status: 401 }),
    );
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("tester");
    await wrapper.find("#login-password").setValue("bad-pass");
    await wrapper.find("form").trigger("submit");

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toBe("用户名或密码错误");
    expect((wrapper.find("#login-password").element as HTMLInputElement).value).toBe("");
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  test("非鉴权错误也用行内文案（formatApiError）", async () => {
    const router = await makeRouter();
    const auth = useAuthStore();
    vi.spyOn(auth, "login").mockRejectedValue(
      Object.assign(new Error("网络异常，请检查服务是否在线"), { code: "NETWORK_ERROR", status: 0 }),
    );
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("tester");
    await wrapper.find("#login-password").setValue("x");
    await wrapper.find("form").trigger("submit");

    expect(wrapper.find('[role="alert"]').text()).toBe("网络异常，请检查服务是否在线");
  });

  test("「忘记密码」给出可执行的管理员重置指引（role=status）", async () => {
    const router = await makeRouter();
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find(".login-link").trigger("click");

    const hint = wrapper.find('[role="status"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("管理");
    expect(hint.text()).toContain("重置密码");
  });

  test("提交中禁用输入与按钮（防重复提交）", async () => {
    const router = await makeRouter();
    const auth = useAuthStore();
    // 永不 resolve：保持 submitting=true
    vi.spyOn(auth, "login").mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });

    await wrapper.find("#login-username").setValue("tester");
    await wrapper.find("#login-password").setValue("x");
    await wrapper.find("form").trigger("submit");

    expect(wrapper.find("#login-username").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".login-submit").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".login-submit").text()).toBe("登录中…");
  });
});
