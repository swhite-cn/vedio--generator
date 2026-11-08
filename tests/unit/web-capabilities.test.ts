// @vitest-environment jsdom
/**
 * T303 能力中心测试：展示格式化纯函数、能力卡（阶段 chips/meta/事件）、
 * 页面结构（可用能力 + 即将上线 3 卡 + 最近运行表）与空态。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import CapabilityCard from "../../apps/web/src/components/CapabilityCard.vue";
import CapabilitiesView from "../../apps/web/src/views/CapabilitiesView.vue";
import {
  formatDateTime,
  formatElapsed,
  formatMediaDuration,
  statusTone,
} from "../../apps/web/src/components/state-mapping";
import type { Capability } from "../../apps/web/src/stores/capabilities";
import type { Project } from "../../apps/web/src/stores/projects";
import { apiRequest } from "../../apps/web/src/services/api";

// 服务端接口统一 mock：本文件只验证「服务端字段 → 展示」的映射
vi.mock("../../apps/web/src/services/api", () => ({
  apiRequest: vi.fn(),
  formatApiError: vi.fn(() => "操作失败"),
}));

const apiRequestMock = vi.mocked(apiRequest);

/** 能力夹具：八阶段（copy/image 后带审核点），与真实注册表字段一致。 */
function makeCapability(): Capability {
  const stages = [
    ["copy", "copy_generate", "文案", true],
    ["image", "image_generate", "配图", true],
    ["scene", "scene_generate", "场景", false],
    ["tts", "tts_generate", "配音", false],
    ["captions", "captions_generate", "字幕", false],
    ["storyboard", "storyboard_generate", "时间轴", false],
    ["render", "render_frames", "逐帧渲染", false],
    ["compose", "compose_video", "视频合成", false],
  ] as const;
  return {
    id: "video-generation",
    name: "短视频生成",
    description: "一句一镜：按口播拆镜头，逐镜配图与渲染。",
    stages: stages.map(([stage, tool, label, reviewGate]) => ({
      stage,
      tool,
      label,
      reviewGate,
    })),
    reviewGates: ["copy", "image"],
    params: [],
    skillDirs: [],
    finalArtifact: "final.mp4",
  };
}

/** 项目夹具（含 T116 派生指标与 latestRun）。 */
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
    created_at: "2026-11-07T01:00:00.000Z",
    updated_at: "2026-11-07T02:00:00.000Z",
    shotCount: 78,
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

/** 构造能力中心页面的内存路由。 */
async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { render: () => null } },
      { path: "/projects", component: { render: () => null } },
      { path: "/projects/:id", component: { render: () => null } },
    ],
  });
  await router.push("/");
  await router.isReady();
  return router;
}

describe("展示格式化（state-mapping 扩展）", () => {
  test("statusTone 把 AntD 语义色映射为 VfPill tone", () => {
    expect(statusTone("success")).toBe("success");
    expect(statusTone("error")).toBe("danger");
    expect(statusTone("warning")).toBe("warning");
    expect(statusTone("processing")).toBe("accent");
    expect(statusTone("default")).toBe("neutral");
  });

  test("formatDateTime 输出本地 MM-DD HH:mm；非法/空值回退破折号", () => {
    // 用本地时间构造，断言与时区无关
    const localIso = new Date(2026, 10, 7, 17, 45).toISOString();
    expect(formatDateTime(localIso)).toBe("11-07 17:45");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  test("formatElapsed 计算已完成 run 耗时；运行中（无 ended_at）不回推", () => {
    const start = new Date(2026, 10, 7, 10, 0, 0).toISOString();
    const end = new Date(2026, 10, 7, 10, 1, 5).toISOString();
    expect(formatElapsed(start, end)).toBe("1m 5s");
    expect(formatElapsed(start, null)).toBe("—");
    expect(formatElapsed(null, end)).toBe("—");
    // 结束早于开始（异常数据）不显示负时长
    expect(formatElapsed(end, start)).toBe("—");
  });

  test("formatMediaDuration 输出 m:ss / h:mm:ss", () => {
    expect(formatMediaDuration(291000)).toBe("4:51");
    expect(formatMediaDuration(3725000)).toBe("1:02:05");
    expect(formatMediaDuration(0)).toBe("—");
    expect(formatMediaDuration(null)).toBe("—");
  });
});

describe("CapabilityCard", () => {
  /** 挂载能力卡的最小入口。 */
  function mountCard(options: { workflowOpen?: boolean } = {}) {
    return mount(CapabilityCard, {
      props: {
        capability: makeCapability(),
        projectCount: 3,
        workflowOpen: options.workflowOpen ?? false,
      },
      global: { plugins: [pinia] },
    });
  }

  test("渲染名称、描述、阶段 chips 与审核标记", () => {
    const wrapper = mountCard();
    expect(wrapper.find(".capability-title").text()).toBe("短视频生成");
    expect(wrapper.find(".capability-desc").text()).toContain("一句一镜");

    const chips = wrapper.findAll(".capability-stage");
    expect(chips).toHaveLength(8);
    expect(chips[0]!.text()).toContain("文案");
    // copy/image 为审核点
    expect(wrapper.findAll(".capability-stage.is-gate")).toHaveLength(2);
  });

  test("meta 展示参考片基线、项目数与最终产物", () => {
    const wrapper = mountCard();
    expect(wrapper.text()).toContain("平均 3.7 秒一次");
    expect(wrapper.text()).toContain("参考片基线");
    expect(wrapper.text()).toContain("已创建项目");
    expect(wrapper.text()).toContain("3");
    expect(wrapper.text()).toContain("final.mp4");
  });

  test("点击按钮分别派发 create 与 toggle-workflow", async () => {
    const wrapper = mountCard();
    const buttons = wrapper.findAll(".vf-button");
    await buttons[0]!.trigger("click");
    await buttons[1]!.trigger("click");
    expect(wrapper.emitted("create")).toHaveLength(1);
    expect(wrapper.emitted("toggle-workflow")).toHaveLength(1);
  });

  test("workflowOpen 时展开工作流说明（序号/阶段/工具/审核点）", () => {
    const wrapper = mountCard({ workflowOpen: true });
    const items = wrapper.findAll(".capability-workflow__item");
    expect(items).toHaveLength(8);
    expect(items[0]!.text()).toContain("1");
    expect(items[0]!.text()).toContain("文案");
    expect(items[0]!.text()).toContain("copy_generate");
    expect(wrapper.findAll(".capability-workflow .vf-pill--warning")).toHaveLength(2);
  });
});

describe("CapabilitiesView（方案 §8.5 第 2 页）", () => {
  /** 挂载页面：能力 + 项目接口按用例返回，NewProjectModal 以 stub 隔离 Antd。 */
  async function mountView(projects: Project[]) {
    const router = await makeRouter();
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/capabilities") return { capabilities: [makeCapability()] };
      if (path === "/api/projects") return { projects };
      return {};
    });
    const wrapper = mount(CapabilitiesView, {
      global: { plugins: [pinia, router], stubs: { NewProjectModal: true } },
    });
    await vi.waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/capabilities");
    });
    await vi.waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/projects");
    });
    return { wrapper, router };
  }

  test("渲染可用能力卡与即将上线 3 张禁用卡", async () => {
    const { wrapper } = await mountView([]);
    expect(wrapper.find(".capability-card").exists()).toBe(true);
    expect(wrapper.find(".capability-title").text()).toBe("短视频生成");

    const upcoming = wrapper.findAll(".upcoming-card");
    expect(upcoming.map((card) => card.find(".upcoming-title").text())).toEqual([
      "抖音短视频",
      "小说推文",
      "产品宣传",
    ]);
    expect(wrapper.findAll(".upcoming-card .vf-pill--neutral")).toHaveLength(3);
  });

  test("最近运行表按 run 时间倒序，字段来自服务端（镜头数/状态/耗时/时间）", async () => {
    const projects = [
      makeProject({
        id: "p-1",
        name: "旧项目",
        latestRun: {
          id: "run-11111111",
          status: "done",
          created_at: new Date(2026, 10, 6, 10, 0).toISOString(),
          started_at: new Date(2026, 10, 6, 10, 0).toISOString(),
          ended_at: new Date(2026, 10, 6, 10, 2).toISOString(),
        },
      }),
      makeProject({
        id: "p-2",
        name: "新项目",
        shotCount: 42,
        latestRun: {
          id: "run-22222222",
          status: "running",
          created_at: new Date(2026, 10, 7, 9, 0).toISOString(),
          started_at: new Date(2026, 10, 7, 9, 0).toISOString(),
          ended_at: null,
        },
      }),
      makeProject({ id: "p-3", name: "无运行项目", latestRun: null }),
    ];
    const { wrapper } = await mountView(projects);

    const rows = wrapper.findAll(".run-table tbody tr");
    // 无 run 的项目不进最近运行表
    expect(rows).toHaveLength(2);
    // 倒序：新项目在前
    expect(rows[0]!.text()).toContain("新项目");
    expect(rows[1]!.text()).toContain("旧项目");

    expect(rows[0]!.text()).toContain("42");
    // 运行中无 ended_at：耗时列显示破折号，不回推估算时长
    expect(rows[0]!.findAll("td")[4]!.text()).toBe("—");
    expect(rows[1]!.find(".vf-pill--success").text()).toBe("已完成");
    expect(rows[0]!.find(".vf-pill--accent").text()).toBe("运行中");
  });

  test("无运行记录时展示空态文案", async () => {
    const { wrapper } = await mountView([makeProject({ latestRun: null })]);
    expect(wrapper.text()).toContain("还没有运行记录");
  });

  test("能力接口失败展示错误与重试入口", async () => {
    const router = await makeRouter();
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/capabilities") throw new Error("offline");
      if (path === "/api/projects") return { projects: [] };
      return {};
    });
    const wrapper = mount(CapabilitiesView, {
      global: { plugins: [pinia, router], stubs: { NewProjectModal: true } },
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain("能力列表加载失败"));
    await wrapper.find(".section-error .link-button").trigger("click");
    // 重试会重新请求能力接口
    await vi.waitFor(() =>
      expect(apiRequestMock.mock.calls.filter(([path]) => path === "/api/capabilities")).toHaveLength(
        2,
      ),
    );
  });

  test("点击最近运行中的项目名跳转工作台", async () => {
    const projects = [
      makeProject({
        id: "p-1",
        name: "示例项目",
        latestRun: {
          id: "run-33333333",
          status: "done",
          created_at: new Date(2026, 10, 7, 9, 0).toISOString(),
          started_at: new Date(2026, 10, 7, 9, 0).toISOString(),
          ended_at: new Date(2026, 10, 7, 9, 1).toISOString(),
        },
      }),
    ];
    const { wrapper, router } = await mountView(projects);
    const pushSpy = vi.spyOn(router, "push");
    await wrapper.find(".run-table tbody .link-button").trigger("click");
    expect(pushSpy).toHaveBeenCalledWith("/projects/p-1");
  });
});
