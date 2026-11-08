// @vitest-environment jsdom
/**
 * T301 设计基元与 AppShell 挂载测试。
 * 基元断言视觉类名/语义结构（CSS 值由 tokens.css 权威，本测试不重复断言色值）；
 * AppShell 断言导航项数（按角色）、面包屑与壳结构。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import Antd from "ant-design-vue";
import VfButton from "../../apps/web/src/components/ui/VfButton.vue";
import VfPill from "../../apps/web/src/components/ui/VfPill.vue";
import VfCard from "../../apps/web/src/components/ui/VfCard.vue";
import VfInput from "../../apps/web/src/components/ui/VfInput.vue";
import VfJsonBlock from "../../apps/web/src/components/ui/VfJsonBlock.vue";
import AppShell from "../../apps/web/src/layouts/AppShell.vue";
import { useAuthStore, type AuthUser } from "../../apps/web/src/stores/auth";

/** 构造挂载用内存路由（当前路径 /projects，带面包屑 meta），避免 mock vue-router 的时序问题。 */
async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    // 覆盖 AppShell 全部导航目标，消除 RouterLink 无路由告警
    routes: [
      { path: "/", component: { render: () => null }, meta: { breadcrumb: ["能力中心"] } },
      { path: "/projects", component: { render: () => null }, meta: { breadcrumb: ["项目"] } },
      { path: "/assets", component: { render: () => null } },
      { path: "/components", component: { render: () => null } },
      { path: "/admin", component: { render: () => null } },
      { path: "/settings", component: { render: () => null } },
    ],
  });
  await router.push("/projects");
  await router.isReady();
  return router;
}

/** 构造指定角色的当前用户夹具。 */
function makeUser(role: "admin" | "user"): AuthUser {
  return {
    id: "u-1",
    username: "tester",
    displayName: "测试用户",
    role,
    mustChangePassword: false,
  };
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  // jsdom 不实现 matchMedia：AppShell 的响应式断点用恒不命中替身
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VfButton", () => {
  test("渲染四种变体类名", () => {
    expect(mount(VfButton, { props: { variant: "accent" } }).classes()).toContain(
      "vf-button--accent",
    );
    expect(mount(VfButton, { props: { variant: "ghost" } }).classes()).toContain("vf-button--ghost");
    expect(mount(VfButton, { props: { variant: "danger" } }).classes()).toContain(
      "vf-button--danger",
    );
    expect(mount(VfButton, { props: { variant: "success" } }).classes()).toContain(
      "vf-button--success",
    );
  });

  test("默认 accent 且点击触发原生 click", async () => {
    const wrapper = mount(VfButton, { slots: { default: "保存" } });
    expect(wrapper.classes()).toContain("vf-button--accent");
    expect(wrapper.text()).toBe("保存");
    await wrapper.trigger("click");
    expect(wrapper.emitted("click")).toHaveLength(1);
  });

  test("disabled 属性透传到原生 button", () => {
    const wrapper = mount(VfButton, { attrs: { disabled: true } });
    expect((wrapper.element as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("VfPill", () => {
  test("tone 决定语义类名，默认 neutral", () => {
    expect(mount(VfPill).classes()).toContain("vf-pill--neutral");
    expect(mount(VfPill, { props: { tone: "success" } }).classes()).toContain("vf-pill--success");
    expect(mount(VfPill, { props: { tone: "danger" } }).classes()).toContain("vf-pill--danger");
  });

  test("dot 为 true 时渲染前置圆点", () => {
    expect(mount(VfPill, { props: { dot: true } }).find(".vf-pill__dot").exists()).toBe(true);
    expect(mount(VfPill).find(".vf-pill__dot").exists()).toBe(false);
  });

  test("文本插槽是 pill 内容主体（颜色不是唯一信息载体）", () => {
    expect(mount(VfPill, { slots: { default: "运行中" } }).text()).toBe("运行中");
  });
});

describe("VfCard", () => {
  test("title 渲染为卡片标题", () => {
    const wrapper = mount(VfCard, { props: { title: "最近运行" }, slots: { default: "内容" } });
    expect(wrapper.find(".vf-card__title").text()).toBe("最近运行");
    expect(wrapper.text()).toContain("内容");
  });

  test("无 title 且无 header 插槽时不渲染头部", () => {
    expect(mount(VfCard, { slots: { default: "x" } }).find(".vf-card__header").exists()).toBe(false);
  });
});

describe("VfInput", () => {
  test("v-model 双向绑定", async () => {
    const wrapper = mount(VfInput, { props: { modelValue: "a" } });
    const input = wrapper.find("input");
    expect((input.element as HTMLInputElement).value).toBe("a");
    input.element.value = "abc";
    await input.trigger("input");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["abc"]);
  });

  test("placeholder 与 ariaLabel 透传", () => {
    const wrapper = mount(VfInput, {
      props: { placeholder: "搜索项目", ariaLabel: "全局搜索" },
    });
    expect(wrapper.find("input").attributes("placeholder")).toBe("搜索项目");
    expect(wrapper.find("input").attributes("aria-label")).toBe("全局搜索");
  });
});

describe("VfJsonBlock", () => {
  test("对象值格式化为缩进 JSON", () => {
    const wrapper = mount(VfJsonBlock, { props: { value: { b: 1, a: [2] } } });
    expect(wrapper.find("code").text()).toBe('{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
  });

  test("复制按钮写入剪贴板并反馈已复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const wrapper = mount(VfJsonBlock, { props: { value: { k: "v" } } });
    await wrapper.find(".vf-json__copy").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('{\n  "k": "v"\n}');
    expect(wrapper.find(".vf-json__copy").text()).toBe("已复制");
  });

  test("copyable=false 时不渲染复制按钮", () => {
    expect(
      mount(VfJsonBlock, { props: { value: {}, copyable: false } }).find(".vf-json__copy").exists(),
    ).toBe(false);
  });
});

describe("AppShell（方案 §8.3）", () => {
  /** 挂载 AppShell 的统一入口：pinia（角色夹具）+ Antd + 内存路由。 */
  async function mountShell(): Promise<ReturnType<typeof mount>> {
    const router = await makeRouter();
    return mount(AppShell, { global: { plugins: [pinia, Antd, router] } });
  }

  test("普通用户可见 4 项导航（管理不可见）", async () => {
    useAuthStore().me = makeUser("user");
    const wrapper = await mountShell();
    const links = wrapper.findAll(".shell-sider .shell-nav__item");
    expect(links.map((link) => link.text())).toEqual(["能力中心", "项目", "素材库", "组件库"]);
  });

  test("admin 可见 5 项导航（含管理）", async () => {
    useAuthStore().me = makeUser("admin");
    const wrapper = await mountShell();
    const links = wrapper.findAll(".shell-sider .shell-nav__item");
    expect(links.map((link) => link.text())).toEqual([
      "能力中心",
      "项目",
      "素材库",
      "组件库",
      "管理",
    ]);
  });

  test("当前路径前缀匹配的导航项带选中态", async () => {
    useAuthStore().me = makeUser("user");
    const wrapper = await mountShell();
    const active = wrapper.findAll(".shell-sider .shell-nav__item.is-active");
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toBe("项目");
  });

  test("面包屑来自 route.meta.breadcrumb", async () => {
    useAuthStore().me = makeUser("user");
    const wrapper = await mountShell();
    expect(wrapper.findAll(".shell-breadcrumb__item").map((node) => node.text())).toEqual(["项目"]);
  });

  test("底部用户卡展示名称与角色", async () => {
    useAuthStore().me = makeUser("admin");
    const wrapper = await mountShell();
    expect(wrapper.find(".shell-user__name").text()).toBe("测试用户");
    expect(wrapper.find(".shell-user__role").text()).toBe("管理员");
  });
});
