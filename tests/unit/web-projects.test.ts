// @vitest-environment jsdom
/**
 * T304 项目列表与新建项目模态测试：
 * - 筛选/排序纯函数；
 * - ProjectCard 服务端字段展示、进度、成片/重试入口与键盘操作；
 * - ProjectsView 卡片网格、筛选切换、空态/错误态、失败重试；
 * - NewProjectModal 两步向导、行内校验、创建与风格锚上传。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import ProjectCard from "../../apps/web/src/components/ProjectCard.vue";
import ProjectsView from "../../apps/web/src/views/ProjectsView.vue";
import NewProjectModal from "../../apps/web/src/components/NewProjectModal.vue";
import {
  PROJECT_FILTERS,
  countProjectFilters,
  filterProjects,
  matchesProjectFilter,
  sortProjectsByUpdatedAt,
} from "../../apps/web/src/components/project-filter";
import type { Capability } from "../../apps/web/src/stores/capabilities";
import type { Project } from "../../apps/web/src/stores/projects";
import { apiRequest } from "../../apps/web/src/services/api";

// 服务端接口统一 mock：本文件只验证「服务端字段 → 展示/提交载荷」
vi.mock("../../apps/web/src/services/api", () => ({
  apiRequest: vi.fn(),
  formatApiError: vi.fn((error: unknown) => {
    const candidate = error as { message?: string } | undefined;
    return `操作失败：${candidate?.message ?? "网络异常"}`;
  }),
}));

const apiRequestMock = vi.mocked(apiRequest);

/** 能力夹具（字段与真实注册表视图一致）。 */
function makeCapability(): Capability {
  return {
    id: "video-generation",
    name: "短视频生成",
    description: "一句一镜：按口播拆镜头，逐镜配图与渲染。",
    stages: [
      { stage: "copy", tool: "copy_generate", label: "文案", reviewGate: true },
      { stage: "image", tool: "image_generate", label: "配图", reviewGate: true },
      { stage: "scene", tool: "scene_generate", label: "场景", reviewGate: false },
    ],
    reviewGates: ["copy", "image"],
    params: [],
    skillDirs: [],
    finalArtifact: "final.mp4",
  };
}

/** 项目夹具（含 T116 派生指标）。 */
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
    created_at: new Date(2026, 10, 7, 9, 0).toISOString(),
    updated_at: new Date(2026, 10, 7, 9, 0).toISOString(),
    shotCount: 42,
    totalMs: 291000,
    progress: 0.5,
    etaSeconds: null,
    boundShotCount: 0,
    latestRun: null,
    ...overrides,
  };
}

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  apiRequestMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造项目列表页使用的内存路由。 */
async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { render: () => null } },
      { path: "/projects", component: { render: () => null } },
      { path: "/projects/:id", component: { render: () => null } },
    ],
  });
  await router.push("/projects");
  await router.isReady();
  return router;
}

/** 以默认接口实现挂载项目列表页（可覆写单个接口）。 */
async function mountProjectsView(
  projects: Project[],
  overrides: { projectsError?: boolean } = {},
) {
  const router = await makeRouter();
  apiRequestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === "/api/capabilities") return { capabilities: [makeCapability()] };
    if (path === "/api/projects") {
      if (overrides.projectsError) throw new Error("offline");
      return { projects };
    }
    if (options?.method === "POST") return { run: { id: "run-1" } };
    return {};
  });
  const wrapper = mount(ProjectsView, {
    global: { plugins: [pinia, router], stubs: { NewProjectModal: true } },
  });
  await vi.waitFor(() => {
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/api/projects")).toBe(true);
  });
  return { wrapper, router };
}

describe("项目筛选与排序纯函数", () => {
  test("matchesProjectFilter 映射四档；进行中包含 running 与 review", () => {
    expect(matchesProjectFilter("running", "active")).toBe(true);
    expect(matchesProjectFilter("review", "active")).toBe(true);
    expect(matchesProjectFilter("draft", "active")).toBe(false);
    expect(matchesProjectFilter("done", "done")).toBe(true);
    expect(matchesProjectFilter("failed", "failed")).toBe(true);
    expect(matchesProjectFilter("done", "failed")).toBe(false);
    expect(matchesProjectFilter("failed", "all")).toBe(true);
  });

  test("filterProjects 与 countProjectFilters 按状态分组计数", () => {
    const projects = [
      makeProject({ id: "a", status: "running" }),
      makeProject({ id: "b", status: "review" }),
      makeProject({ id: "c", status: "done" }),
      makeProject({ id: "d", status: "failed" }),
      makeProject({ id: "e", status: "draft" }),
    ];
    expect(countProjectFilters(projects)).toEqual({ all: 5, active: 2, done: 1, failed: 1 });
    expect(filterProjects(projects, "active").map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("sortProjectsByUpdatedAt 按更新时间倒序且不修改入参", () => {
    const older = makeProject({ id: "old", updated_at: "2026-11-06T10:00:00.000Z" });
    const newer = makeProject({ id: "new", updated_at: "2026-11-07T10:00:00.000Z" });
    const input = [older, newer];
    expect(sortProjectsByUpdatedAt(input).map((item) => item.id)).toEqual(["new", "old"]);
    expect(input.map((item) => item.id)).toEqual(["old", "new"]);
  });

  test("筛选档位表固定四项且顺序稳定", () => {
    expect(PROJECT_FILTERS.map((item) => item.label)).toEqual([
      "全部",
      "进行中",
      "已完成",
      "失败",
    ]);
  });
});

describe("ProjectCard", () => {
  test("展示名称、主题、状态 pill、镜头/时长与能力名", () => {
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject(), capabilityName: "短视频生成" },
    });
    expect(wrapper.find(".project-card__name").text()).toBe("示例项目");
    expect(wrapper.find(".project-card__topic").text()).toBe("示例主题");
    expect(wrapper.find(".vf-pill--accent").text()).toBe("运行中");
    expect(wrapper.find(".project-card__metrics").text()).toContain("镜头 42");
    expect(wrapper.find(".project-card__metrics").text()).toContain("时长 4:51");
    expect(wrapper.find(".project-card__meta").text()).toContain("短视频生成");
    expect(wrapper.find(".project-card__meta").text()).toContain("11-07");
  });

  test("进行中展示服务端进度条（aria-valuenow）", () => {
    const wrapper = mount(ProjectCard, { props: { project: makeProject() } });
    const bar = wrapper.find(".project-card__progress");
    expect(bar.attributes("role")).toBe("progressbar");
    expect(bar.attributes("aria-valuenow")).toBe("50");
    expect(wrapper.find(".project-card__percent").text()).toBe("50%");
  });

  test("已完成展示成片就绪，不再显示进度条", () => {
    const wrapper = mount(ProjectCard, {
      props: { project: makeProject({ status: "done", progress: 1 }) },
    });
    expect(wrapper.find(".project-card__ready").text()).toBe("成片就绪");
    expect(wrapper.find(".project-card__progress").exists()).toBe(false);
  });

  test("失败展示错误码与重试按钮；重试不触发卡片 open", async () => {
    const wrapper = mount(ProjectCard, {
      props: {
        project: makeProject({
          status: "failed",
          latestRun: {
            id: "run-1",
            status: "failed",
            created_at: "2026-11-07T09:00:00.000Z",
            started_at: null,
            ended_at: null,
            error_code: "TOOL_UNAVAILABLE",
          },
        }),
      },
    });
    expect(wrapper.find(".project-card__error").text()).toBe("TOOL_UNAVAILABLE");

    const retryButton = wrapper.find(".project-card__failed .vf-button");
    await retryButton.trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    expect(wrapper.emitted("open")).toBeUndefined();
  });

  test("点击卡片与 Enter 键均派发 open", async () => {
    const wrapper = mount(ProjectCard, { props: { project: makeProject() } });
    await wrapper.trigger("click");
    await wrapper.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("open")).toHaveLength(2);
    expect(wrapper.emitted("open")![0]).toEqual(["p-1"]);
  });
});

describe("ProjectsView（方案 §8.5 第 4 页）", () => {
  test("卡片按最近更新倒序渲染，页头展示总数", async () => {
    const projects = [
      makeProject({ id: "p-old", name: "旧项目", updated_at: "2026-11-06T10:00:00.000Z" }),
      makeProject({
        id: "p-new",
        name: "新项目",
        status: "done",
        updated_at: "2026-11-07T10:00:00.000Z",
      }),
    ];
    const { wrapper } = await mountProjectsView(projects);
    const cards = wrapper.findAll(".project-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.find(".project-card__name").text()).toBe("新项目");
    expect(cards[1]!.find(".project-card__name").text()).toBe("旧项目");
    expect(wrapper.find(".page-subtitle").text()).toContain("共 2 个项目");
  });

  test("筛选按钮展示计数，点击后只显示命中的项目", async () => {
    const projects = [
      makeProject({ id: "p-run", name: "运行中项目", status: "running" }),
      makeProject({ id: "p-done", name: "已完成项目", status: "done" }),
      makeProject({ id: "p-failed", name: "失败项目", status: "failed" }),
    ];
    const { wrapper } = await mountProjectsView(projects);

    const filters = wrapper.findAll(".filter-button");
    expect(filters).toHaveLength(4);
    expect(filters[0]!.text()).toContain("全部");
    expect(filters[0]!.text()).toContain("3");
    expect(filters[1]!.text()).toContain("1");
    expect(filters[0]!.attributes("aria-pressed")).toBe("true");

    await filters[2]!.trigger("click");
    const cards = wrapper.findAll(".project-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.find(".project-card__name").text()).toBe("已完成项目");
    expect(filters[2]!.attributes("aria-pressed")).toBe("true");
    expect(filters[0]!.attributes("aria-pressed")).toBe("false");
  });

  test("无项目时展示空态与新建入口", async () => {
    const { wrapper } = await mountProjectsView([]);
    expect(wrapper.find(".empty-title").text()).toBe("还没有项目");
    expect(wrapper.find(".empty-desc").text()).toContain("从能力中心");
    expect(wrapper.findAll(".vf-button").some((button) => button.text() === "新建项目")).toBe(true);
  });

  test("列表接口失败展示错误与重试入口，重试重新请求", async () => {
    const { wrapper } = await mountProjectsView([], { projectsError: true });
    await vi.waitFor(() => expect(wrapper.find(".section-error").exists()).toBe(true));
    await wrapper.find(".link-button").trigger("click");
    await vi.waitFor(() =>
      expect(apiRequestMock.mock.calls.filter(([path]) => path === "/api/projects")).toHaveLength(2),
    );
  });

  test("失败项目点击重试发起新 run 并刷新列表", async () => {
    const failed = makeProject({ id: "p-failed", status: "failed" });
    const { wrapper } = await mountProjectsView([failed]);
    await wrapper.find(".project-card__failed .vf-button").trigger("click");
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, options]) =>
            path === "/api/projects/p-failed/runs" &&
            (options as { method?: string } | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(apiRequestMock.mock.calls.filter(([path]) => path === "/api/projects")).toHaveLength(2),
    );
  });
});

describe("NewProjectModal（方案 §8.5 第 3 页）", () => {
  /** VfModal 桩：避免 Antd a-modal 的 teleport，保留 open 与 footer 插槽。 */
  const VfModalStub = {
    props: ["open", "title", "width"],
    emits: ["update:open"],
    template:
      '<div class="vf-modal-stub" v-if="open"><slot /><footer class="stub-footer"><slot name="footer" /></footer></div>',
  };

  /** 挂载向导（默认已打开，接口按路径返回）。 */
  async function mountModal(capabilities: Capability[] = [makeCapability()]) {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/capabilities") return { capabilities };
      if (path === "/api/profiles") {
        return { profiles: [{ value: "landscape-1080p", label: "横屏 1080p" }] };
      }
      if (path === "/api/projects") {
        return { project: makeProject({ id: "p-created", name: "新项目", status: "draft" }) };
      }
      if (path.endsWith("/assets/upload")) return { asset: { id: "asset-1" } };
      return {};
    });
    const wrapper = mount(NewProjectModal, {
      props: { open: true },
      global: { plugins: [pinia], stubs: { VfModal: VfModalStub } },
    });
    await vi.waitFor(() =>
      expect(apiRequestMock.mock.calls.some(([path]) => path === "/api/capabilities")).toBe(true),
    );
    // 等能力列表渲染并完成默认选中，避免与异步初始化竞态
    await vi.waitFor(() =>
      expect(wrapper.findAll(".capability-option.is-selected")).toHaveLength(1),
    );
    return wrapper;
  }

  /** 点击底部指定文案按钮。 */
  async function clickFooter(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
    const button = wrapper.findAll(".vf-button").find((item) => item.text() === label);
    expect(button, `未找到按钮：${label}`).toBeTruthy();
    await button!.trigger("click");
  }

  test("第一步展示能力卡片并默认选中第一条", async () => {
    const wrapper = await mountModal();
    const options = wrapper.findAll(".capability-option");
    expect(options).toHaveLength(1);
    expect(options[0]!.find(".option-name").text()).toBe("短视频生成");
    expect(options[0]!.classes()).toContain("is-selected");
    expect(options[0]!.attributes("aria-pressed")).toBe("true");
  });

  test("下一步进入参数表单；空表单提交显示行内校验且不发创建请求", async () => {
    const wrapper = await mountModal();
    await clickFooter(wrapper, "下一步");
    expect(wrapper.find(".project-form").exists()).toBe(true);

    await clickFooter(wrapper, "创建项目");
    expect(wrapper.find(".field-error").text()).toContain("请输入项目名称");
    expect(wrapper.findAll(".field-error").some((item) => item.text().includes("请输入主题"))).toBe(
      true,
    );
    expect(
      apiRequestMock.mock.calls.some(
        ([path, options]) =>
          path === "/api/projects" && (options as { method?: string } | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  test("填写有效参数创建项目并派发 created/关闭事件", async () => {
    const wrapper = await mountModal();
    await clickFooter(wrapper, "下一步");

    await wrapper.find("#np-name").setValue("新项目");
    await wrapper.find("#np-topic").setValue("示例主题");
    await wrapper.find("#np-style").setValue("轻松科普");
    await clickFooter(wrapper, "创建项目");

    await vi.waitFor(() => expect(wrapper.emitted("created")).toHaveLength(1));
    const created = wrapper.emitted("created")![0]![0] as Project;
    expect(created.id).toBe("p-created");
    expect(wrapper.emitted("update:open")![0]).toEqual([false]);

    const createCall = apiRequestMock.mock.calls.find(
      ([path, options]) =>
        path === "/api/projects" && (options as { method?: string } | undefined)?.method === "POST",
    );
    expect((createCall?.[1] as { body?: Record<string, unknown> }).body).toMatchObject({
      capabilityId: "video-generation",
      name: "新项目",
      topic: "示例主题",
      style: "轻松科普",
      profile: "landscape-1080p",
    });
  });

  test("选择风格锚参考图后，创建项目再上传为项目资产", async () => {
    const wrapper = await mountModal();
    await clickFooter(wrapper, "下一步");

    await wrapper.find("#np-name").setValue("新项目");
    await wrapper.find("#np-topic").setValue("示例主题");

    const file = new File(["fake-image"], "anchor.png", { type: "image/png" });
    const input = wrapper.find("#np-anchor");
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    expect(wrapper.find(".anchor-selected").text()).toContain("anchor.png");

    await clickFooter(wrapper, "创建项目");
    await vi.waitFor(() => expect(wrapper.emitted("created")).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(([path]) => path === "/api/projects/p-created/assets/upload"),
      ).toBe(true),
    );
  });

  test("非图片文件被前置拒绝，不进入上传", async () => {
    const wrapper = await mountModal();
    await clickFooter(wrapper, "下一步");

    const file = new File(["text"], "note.txt", { type: "text/plain" });
    const input = wrapper.find("#np-anchor");
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    expect(wrapper.find(".field-error").text()).toContain("需为图片文件");
    expect(wrapper.find(".anchor-selected").exists()).toBe(false);
  });

  test("预选能力时直接进入第二步", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/capabilities") return { capabilities: [makeCapability()] };
      if (path === "/api/profiles") return { profiles: [] };
      return {};
    });
    const wrapper = mount(NewProjectModal, {
      props: { open: true, initialCapabilityId: "video-generation" },
      global: { plugins: [pinia], stubs: { VfModal: VfModalStub } },
    });
    await vi.waitFor(() => expect(wrapper.find(".project-form").exists()).toBe(true));
  });
});
