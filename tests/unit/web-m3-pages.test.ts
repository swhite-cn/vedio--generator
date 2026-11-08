// @vitest-environment jsdom
/**
 * M3 页面测试（T305–T312）：工作台 4 Tab、素材库、组件库、分镜编辑器、管理 store 与顶栏搜索。
 * 服务端接口统一 mock；只断言「服务端字段 → 展示/交互载荷」。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import Antd from "ant-design-vue";
import WorkbenchTabs from "../../apps/web/src/components/WorkbenchTabs.vue";
import AssetsView from "../../apps/web/src/views/AssetsView.vue";
import ComponentsView from "../../apps/web/src/views/ComponentsView.vue";
import StoryboardEditorView from "../../apps/web/src/views/StoryboardEditorView.vue";
import RunDetailView from "../../apps/web/src/views/RunDetailView.vue";
import AppShell from "../../apps/web/src/layouts/AppShell.vue";
import { useAdminStore } from "../../apps/web/src/stores/admin";
import { useAuthStore, type AuthUser } from "../../apps/web/src/stores/auth";
import { apiRequest } from "../../apps/web/src/services/api";
import type { Project } from "../../apps/web/src/stores/projects";
import { stagePlaceholders } from "../../apps/web/src/stores/workbench-reducer";

vi.mock("../../apps/web/src/services/api", () => ({
  apiRequest: vi.fn(),
  formatApiError: vi.fn((error: unknown) => {
    const candidate = error as { message?: string } | undefined;
    return `操作失败：${candidate?.message ?? "网络异常"}`;
  }),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));

vi.mock("../../apps/web/src/services/media-ticket", () => ({
  getMediaTicket: vi.fn(async () => "test-ticket"),
  clearMediaTicket: vi.fn(),
}));

const apiRequestMock = vi.mocked(apiRequest);

/** 项目夹具。 */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    user_id: "u-1",
    capability_id: "video-generation",
    name: "示例项目",
    topic: "示例主题",
    style: null,
    profile: "landscape-1080p",
    status: "running",
    created_at: "2026-11-07T09:00:00.000Z",
    updated_at: "2026-11-07T09:00:00.000Z",
    shotCount: 2,
    totalMs: 12000,
    progress: 0.5,
    latestRun: null,
    ...overrides,
  };
}

/** 分镜聚合夹具（2 镜 / 1 场景 / 2 cue）。 */
function makeStoryboard() {
  const shot1 = {
    shotId: "sh-001",
    sceneId: "sc-1",
    chapterNo: 1,
    sceneTitle: "第一章",
    narration: "第一句口播",
    onScreenText: "第一屏文字",
    emphasis: ["第一"],
    visualType: "image",
    component: null,
    assetRefs: [{ assetId: "a-1", label: "图 1", role: "background" }],
    anchorKeys: ["proton-red"],
    imagePath: "images/sh-001.png",
    transitionIn: "hard-cut",
    transitionOut: "hard-cut",
  };
  const shot2 = {
    ...shot1,
    shotId: "sh-002",
    narration: "第二句口播",
    onScreenText: "第二屏文字",
    emphasis: [],
    imagePath: "images/sh-002.png",
  };
  return {
    project: { id: "p-1", name: "示例项目", profile: "landscape-1080p" },
    contractVersion: "2.0",
    copy: {
      topic: "示例主题",
      style: "科普",
      title: "标题",
      styleAnchors: [
        { key: "proton-red", label: "质子红", assetPath: "assets/anchor-a.png", seed: 7 },
      ],
      scenes: [{ sceneId: "sc-1", chapterNo: 1, title: "第一章", shots: [shot1, shot2] }],
    },
    scenes: [{ sceneId: "sc-1", chapterNo: 1, title: "第一章", shotIds: ["sh-001", "sh-002"] }],
    shots: [shot1, shot2],
    cues: [
      { cueId: "c-1", shotId: "sh-001", kind: "narration", startMs: 0, endMs: 5000, text: "第一句口播" },
      { cueId: "c-2", shotId: "sh-002", kind: "narration", startMs: 5000, endMs: 12000, text: "第二句口播" },
    ],
    timeline: {
      fps: 30,
      tailPauseMs: 500,
      timingSource: "estimated",
      totalMs: 12000,
      shots: [
        { shotId: "sh-001", sceneId: "sc-1", startMs: 0, endMs: 5000, durationMs: 5000 },
        { shotId: "sh-002", sceneId: "sc-1", startMs: 5000, endMs: 12000, durationMs: 7000 },
      ],
      cues: [],
    },
    theme: {
      theme: {
        id: "documentary-dark",
        name: "纪实暗",
        tokens: {
          text: "#E5E0D5",
          background: "#111310",
          accent: "#F1E21D",
          secondary: ["#B33630"],
          font_family: "Noto Sans",
        },
      },
    },
    spec: null,
    components: [{ id: "keyword-block", name: "关键词块", category: "text" }],
    assets: [],
    quality: {
      version: "1",
      runId: "run-1",
      generatedAt: "2026-11-07T10:00:00.000Z",
      checks: [
        { id: "freeze", label: "静帧", status: "pass", violations: [] },
        { id: "subtitle-overflow", label: "字幕溢出", status: "fail", violations: [{ shotId: "sh-002", detail: "超过 18 字" }] },
      ],
    },
    subtitles: { relativePath: "captions/subtitle.ass" },
    specPath: "scenes/spec.json",
  };
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  apiRequestMock.mockReset();
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

/** 内存路由（覆盖 M3 全部页面）。 */
async function makeRouter(path = "/"): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { render: () => null } },
      { path: "/projects", component: { render: () => null } },
      { path: "/projects/:id", component: { render: () => null } },
      { path: "/projects/:id/storyboard", component: { render: () => null } },
      { path: "/projects/:id/runs/:runId", component: { render: () => null } },
      { path: "/assets", component: { render: () => null } },
      { path: "/components", component: { render: () => null } },
      { path: "/admin", component: { render: () => null } },
      { path: "/settings", component: { render: () => null } },
    ],
  });
  await router.push(path);
  await router.isReady();
  return router;
}

describe("WorkbenchTabs（T305/T306）", () => {
  /** 挂载工作台右侧 Tabs（产物子面板以桩隔离 Antd Tabs）。 */
  async function mountTabs() {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects/p-1/storyboard") return makeStoryboard();
      if (path === "/api/projects/p-1/assets") return { items: [], categories: [] };
      return {};
    });
    const router = await makeRouter("/projects/p-1");
    const wrapper = mount(WorkbenchTabs, {
      props: {
        project: makeProject(),
        run: null,
        stages: stagePlaceholders(),
        artifacts: { finalVideoExists: false, entries: [] },
        assets: [
          {
            id: "a-1",
            project_id: "p-1",
            source: "uploaded",
            kind: "image",
            label: "图 1",
            relative_path: "assets/a.png",
            mime_type: "image/png",
            size_bytes: 100,
            boundShots: 2,
            created_at: "2026-11-07T09:00:00.000Z",
          },
        ],
        activeTab: "stage",
      },
      global: {
        plugins: [pinia, router, Antd],
        stubs: { ArtifactTabs: true, FinalOutputCard: true },
      },
    });
    await vi.waitFor(() =>
      expect(apiRequestMock.mock.calls.some(([path]) => path === "/api/projects/p-1/storyboard")).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(wrapper.text()).toContain("第一章"));
    return { wrapper, router };
  }

  test("四 Tab 切换与阶段/质检展示", async () => {
    const { wrapper } = await mountTabs();
    expect(wrapper.findAll(".wb-tab")).toHaveLength(4);
    expect(wrapper.find(".wb-quality__list").text()).toContain("静帧");

    await wrapper.findAll(".wb-tab")[1]!.trigger("click");
    expect(wrapper.find(".wb-scenes").text()).toContain("第一章");
    expect(wrapper.find(".wb-scenes").text()).toContain("sh-001");
    expect(wrapper.find(".wb-scenes").text()).toContain("1 cue");

    await wrapper.findAll(".wb-tab")[2]!.trigger("click");
    expect(wrapper.find(".wb-asset").text()).toContain("已绑定 2 镜");
    await wrapper.find(".wb-asset .vf-button").trigger("click");
    expect(wrapper.emitted("reference-asset")?.[0]).toEqual(["a-1"]);

    await wrapper.findAll(".wb-tab")[3]!.trigger("click");
    expect(wrapper.emitted("update:activeTab")?.at(-1)).toEqual(["artifacts"]);
  });

  test("质检失败项定位到镜头号", async () => {
    const { wrapper } = await mountTabs();
    expect(wrapper.text()).toContain("#sh-002");
  });
});

describe("AssetsView（T309）", () => {
  test("项目选择、6 类筛选、绑定计数与风格锚 banner", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects") return { projects: [makeProject()] };
      if (path === "/api/projects/p-1/assets") {
        return {
          categories: ["ai-generated", "live-action", "archive-photo", "3d-render", "video-clip", "style-anchor"],
          items: [
            {
              id: "a-1",
              project_id: "p-1",
              source: "uploaded",
              kind: "image",
              visual_category: "live-action",
              label: "现场.png",
              relative_path: "assets/a.png",
              mime_type: "image/png",
              size_bytes: 1024,
              boundShots: 3,
              created_at: "2026-11-07T09:00:00.000Z",
            },
          ],
        };
      }
      if (path === "/api/projects/p-1/storyboard") return makeStoryboard();
      return {};
    });
    const router = await makeRouter("/assets");
    const wrapper = mount(AssetsView, {
      global: { plugins: [pinia, router], stubs: { StyleAnchorModal: true } },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("现场.png"));

    expect(wrapper.findAll(".filter-button")).toHaveLength(7);
    expect(wrapper.text()).toContain("已绑定 3 镜头");
    expect(wrapper.find(".anchor-bar").text()).toContain("质子红");
    expect(wrapper.find(".anchor-bar").text()).toContain("seed 7");

    const liveAction = wrapper
      .findAll(".filter-button")
      .find((button) => button.text().includes("实拍上传"));
    await liveAction!.trigger("click");
    expect(wrapper.findAll(".asset-card")).toHaveLength(1);
  });

  test("管理锚点：绑定素材/编辑 seed/显式重建", async () => {
    apiRequestMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === "/api/projects") return { projects: [makeProject()] };
      if (path === "/api/projects/p-1/assets") {
        return {
          categories: ["ai-generated", "style-anchor"],
          items: [
            {
              id: "a-1",
              project_id: "p-1",
              source: "uploaded",
              kind: "image",
              visual_category: "live-action",
              label: "锚图.png",
              relative_path: "assets/a.png",
              mime_type: "image/png",
              size_bytes: 1024,
              boundShots: 3,
              created_at: "2026-11-07T09:00:00.000Z",
            },
          ],
        };
      }
      if (path === "/api/projects/p-1/storyboard") return makeStoryboard();
      if (path === "/api/projects/p-1/style-anchors/proton-red" && options?.method === "PATCH") {
        return { anchor: { key: "proton-red", label: "质子红", color: "#B33630", seed: 9, assetId: "a-1" } };
      }
      if (path === "/api/projects/p-1/style-anchors/proton-red/rebuild") {
        return { anchor: { key: "proton-red", label: "质子红", color: "#B33630", seed: 9 }, archived: true, nextStage: "image" };
      }
      return {};
    });
    const router = await makeRouter("/assets");
    /** 用内联桩替换 a-modal，避免 teleport 导致测试找不到弹层内容。 */
    const VfModalStub = {
      props: ["open", "title"],
      template: `<div v-if="open" class="vf-modal-stub"><h2>{{ title }}</h2><slot /><slot name="footer" /></div>`,
    };
    const wrapper = mount(AssetsView, {
      global: { plugins: [pinia, router, Antd], stubs: { VfModal: VfModalStub } },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("质子红"));

    await wrapper
      .findAll(".anchor-bar__head .vf-button")
      .find((button) => button.text().includes("管理锚点"))!
      .trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".vf-modal-stub").exists()).toBe(true));
    expect(wrapper.find(".sa-list").text()).toContain("质子红");
    expect(wrapper.find(".sa-list").text()).toContain("proton-red");

    // 绑定素材 + 编辑 seed 后保存
    await wrapper.find("select[aria-label='风格锚 proton-red 绑定的图片资产']").setValue("a-1");
    await wrapper.find("input[aria-label='风格锚 proton-red 的 seed']").setValue("9");
    await wrapper
      .findAll(".sa-row .vf-button")
      .find((button) => button.text() === "保存")!
      .trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, options]) =>
            path === "/api/projects/p-1/style-anchors/proton-red" &&
            (options as { method?: string } | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(
      apiRequestMock.mock.calls.find(
        ([path, options]) =>
          path === "/api/projects/p-1/style-anchors/proton-red" &&
          (options as { method?: string } | undefined)?.method === "PATCH",
      )?.[1],
    ).toMatchObject({ body: { seed: 9, assetId: "a-1" } });

    // 显式重建
    await wrapper
      .findAll(".sa-row .vf-button")
      .find((button) => button.text() === "重建")!
      .trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(([path]) =>
          String(path).endsWith("/style-anchors/proton-red/rebuild"),
        ),
      ).toBe(true),
    );
  });
});

describe("ComponentsView（T310）", () => {
  test("渲染组件卡片、参数名与新增指引", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/components") {
        return {
          items: [
            {
              id: "keyword-block",
              name: "关键词块",
              category: "text",
              coverageNote: "参考片占比 28%",
              paramsSchema: { title: { type: "string", required: true }, words: { type: "string" } },
              animations: ["title-in"],
            },
          ],
        };
      }
      if (path === "/api/components/keyword-block/preview") {
        return { fixture: { componentId: "keyword-block", props: { title: "关键词", words: "A · B" } } };
      }
      return {};
    });
    const router = await makeRouter("/components");
    const wrapper = mount(ComponentsView, { global: { plugins: [pinia, router] } });
    await vi.waitFor(() => expect(wrapper.text()).toContain("关键词块"));
    expect(wrapper.find(".component-preview__text").text()).toBe("关键词");
    expect(wrapper.text()).toContain("title*");
    expect(wrapper.text()).toContain("参考片占比 28%");
    expect(wrapper.text()).toContain("新增组件");
  });
});

describe("StoryboardEditorView（T308）", () => {
  test("画布/三轨展示，保存屏上文字与单镜重生成", async () => {
    apiRequestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/api/projects/p-1" && (!options || options.method === undefined)) {
        return { project: makeProject() };
      }
      if (path === "/api/projects/p-1/storyboard") return makeStoryboard();
      if (path === "/api/projects/p-1/shots/sh-001" && options?.method === "PATCH") {
        return { shot: makeStoryboard().shots[0] };
      }
      if (path === "/api/projects/p-1/shots/sh-001/regenerate") {
        return { run: { id: "run-9" } };
      }
      return {};
    });
    const router = await makeRouter("/projects/p-1/storyboard");
    const wrapper = mount(StoryboardEditorView, {
      global: { plugins: [pinia, router], stubs: { VfButton: false } },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("第一屏文字"));

    expect(wrapper.findAll(".se-shot")).toHaveLength(2);
    expect(wrapper.findAll(".se-track")).toHaveLength(3);
    expect(wrapper.find(".se-canvas__text").text()).toBe("第一屏文字");

    await wrapper.find("#se-onscreen").setValue("改过的文字");
    await wrapper
      .findAll(".se-field .vf-button")
      .find((button) => button.text() === "保存文字")!
      .trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, options]) =>
            path === "/api/projects/p-1/shots/sh-001" &&
            (options as { method?: string } | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );

    await wrapper
      .findAll(".se-inspector__actions .vf-button")
      .find((button) => button.text().includes("重生成"))!
      .trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(([path]) =>
          String(path).endsWith("/shots/sh-001/regenerate"),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe("/projects/p-1/runs/run-9"),
    );
  });
});

describe("RunDetailView（T404）", () => {
  test("质检失败项定位镜头，一键重跑该镜", async () => {
    apiRequestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      // 重跑后跳转到新 run 会再次拉 trace，统一返回同一份空留痕
      if (path.startsWith("/api/runs/")) {
        return {
          run: {
            id: "run-1",
            project_id: "p-1",
            status: "done",
            trigger: "user",
            created_at: "2026-11-08T00:00:00.000Z",
            started_at: "2026-11-08T00:00:00.000Z",
            ended_at: "2026-11-08T00:01:00.000Z",
            error_code: null,
            contract_version: "2.0",
          },
          stages: [],
          toolCalls: [],
          llmCalls: [],
          events: [],
          total: { toolCalls: 0, llmCalls: 0 },
          paging: { limit: 50, offset: 0 },
        };
      }
      if (path === "/api/projects/p-1/quality") {
        return {
          report: {
            version: "1",
            runId: "run-1",
            generatedAt: "2026-11-08T00:01:00.000Z",
            checks: [
              {
                id: "subtitle-overflow",
                label: "字幕溢出",
                status: "fail",
                violations: [{ shotId: "sh-002", detail: "字幕 c-2 长 24 字，超过单行上限 18" }],
              },
              {
                id: "contrast",
                label: "画面对比度",
                status: "warn",
                violations: [{ detail: "文本/背景对比度 6.10:1，低于 7.2:1" }],
              },
            ],
          },
        };
      }
      if (path === "/api/projects/p-1/shots/sh-002/regenerate" && options?.method === "POST") {
        return { run: { id: "run-9" } };
      }
      return {};
    });

    const router = await makeRouter("/projects/p-1/runs/run-1");
    const wrapper = mount(RunDetailView, { global: { plugins: [pinia, router, Antd] } });
    await vi.waitFor(() => expect(wrapper.text()).toContain("字幕溢出"));
    expect(wrapper.text()).toContain("#sh-002");
    // 仅带 shotId 的违规项有重跑入口（对比度是主题级问题）
    expect(wrapper.findAll(".run-quality__rerun")).toHaveLength(1);

    await wrapper.find(".run-quality__rerun").trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, options]) =>
            path === "/api/projects/p-1/shots/sh-002/regenerate" &&
            (options as { method?: string } | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(
      apiRequestMock.mock.calls.find(
        ([path, options]) =>
          path === "/api/projects/p-1/shots/sh-002/regenerate" &&
          (options as { method?: string } | undefined)?.method === "POST",
      )?.[1],
    ).toMatchObject({
      body: { stages: ["tts", "storyboard", "render", "compose"] },
    });
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe("/projects/p-1/runs/run-9"),
    );
  });
});

describe("管理 store（T311）", () => {
  test("KPI 与登录日志从服务端加载", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/admin/overview") {
        return { totalUsers: 3, totalProjects: 2, runsThisWeek: 4, successRate: 75 };
      }
      if (path.startsWith("/api/admin/login-events")) {
        return {
          events: [
            {
              id: "e-1",
              user_id: null,
              username: "alice",
              ok: false,
              reason: "INVALID_CREDENTIALS",
              ip: "127.0.0.1",
              user_agent: "vitest",
              created_at: "2026-11-07T09:00:00.000Z",
            },
          ],
        };
      }
      return {};
    });
    const admin = useAdminStore();
    await admin.loadOverview();
    await admin.loadLoginEvents();
    expect(admin.overview).toMatchObject({ totalUsers: 3, runsThisWeek: 4, successRate: 75 });
    expect(admin.loginEvents[0]).toMatchObject({ username: "alice", ok: false });
  });
});

describe("AppShell 全局搜索（T312）", () => {
  test("输入关键词展示三类结果，键盘 Enter 打开项目", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/search")) {
        return {
          q: "科普",
          projects: [{ id: "p-1", name: "科普视频", topic: "主题", status: "done" }],
          assets: [
            {
              id: "a-1",
              project_id: "p-1",
              project_name: "科普视频",
              label: "安全帽.png",
              kind: "image",
              source: "uploaded",
            },
          ],
          components: [],
        };
      }
      return {};
    });
    const router = await makeRouter("/projects");
    useAuthStore().me = {
      id: "u-1",
      username: "tester",
      displayName: "测试用户",
      role: "admin",
      mustChangePassword: false,
    } satisfies AuthUser;
    const wrapper = mount(AppShell, {
      props: {},
      slots: { default: "<div>内容</div>" },
      global: { plugins: [pinia, router, Antd] },
    });

    const input = wrapper.find("input[aria-label='全局搜索']");
    await input.setValue("科普");
    await vi.waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(wrapper.find(".search-panel").exists()).toBe(true));
    expect(wrapper.findAll(".search-hit")).toHaveLength(2);
    expect(wrapper.text()).toContain("科普视频");
    expect(wrapper.text()).toContain("安全帽.png");

    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/projects/p-1"));
  });
});
