// @vitest-environment jsdom
/**
 * 产物面板 v2 回归测试（L1 / T505）。
 *
 * 覆盖点：工作台「产物」Tab 的文案 / 场景 / 音频 / 时间轴四个子面板
 * 均以契约 v2 的结构化产物（`copy.json` / `scenes/spec.json` / `audio/cues.json` / `timeline.json`）
 * 驱动，而不是 v1 的 `{ entries: [] }` 形状；重生成载荷按镜头粒度（`shotId`）上报。
 * 服务端接口统一 mock，只断言「产物文档 → 展示/交互载荷」。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import Antd from "ant-design-vue";
import ArtifactTabs from "../../apps/web/src/components/ArtifactTabs.vue";
import { apiRequest } from "../../apps/web/src/services/api";
import type { Project } from "../../apps/web/src/stores/projects";
import type { ArtifactIndex } from "../../apps/web/src/stores/workbench-reducer";

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

/** 项目夹具（提供 `user_id` / `name` 供媒体地址构造）。 */
function makeProject(): Project {
  return {
    id: "p-1",
    user_id: "u-1",
    capability_id: "video-generation",
    name: "示例项目",
    topic: "示例主题",
    style: null,
    profile: "landscape-1080p",
    status: "done",
    created_at: "2026-11-08T09:00:00.000Z",
    updated_at: "2026-11-08T09:00:00.000Z",
    shotCount: 2,
    totalMs: 12000,
    progress: 1,
    latestRun: null,
  };
}

/** 产物索引夹具：六类产物齐备，均为契约 v2 相对路径。 */
function makeArtifacts(): ArtifactIndex {
  return {
    finalVideoExists: true,
    entries: [
      { stage: "copy", label: "文案", relativePath: "copy.json", sizeBytes: 100 },
      { stage: "scene", label: "场景规格", relativePath: "scenes/spec.json", sizeBytes: 200 },
      { stage: "tts", label: "音频 cues", relativePath: "audio/cues.json", sizeBytes: 300 },
      { stage: "storyboard", label: "时间轴", relativePath: "timeline.json", sizeBytes: 400 },
      { stage: "compose", label: "视频合成", relativePath: "final.mp4", sizeBytes: 500 },
    ],
  };
}

/** copy.json v2 夹具：镜头挂在 `scene.shots` 下（区别于 v1 的扁平 `narration`）。 */
const copyDoc = {
  topic: "示例主题",
  style: "科普",
  title: "标题",
  scenes: [
    {
      sceneId: "sc-1",
      title: "第一章",
      shots: [
        { shotId: "sh-001", narration: "第一句口播" },
        { shotId: "sh-002", narration: "第二句口播" },
      ],
    },
  ],
};

/** scenes/spec.json 夹具：组件选型 + 转场 + 动效。 */
const sceneDoc = {
  themeId: "documentary-dark",
  shots: [
    {
      shotId: "sh-001",
      visualType: "component",
      componentId: "keyword-block",
      transition: { in: "hard-cut", out: "fade-120" },
      animations: [{}, {}, {}],
    },
    { shotId: "sh-002", visualType: "image" },
  ],
};

/** audio/cues.json 夹具：镜头音频切点。 */
const audioDoc = {
  timingSource: "estimated",
  shots: [
    {
      shotId: "sh-001",
      sceneId: "sc-1",
      audioPath: "audio/sh-001.mp3",
      durationMs: 5000,
      startMs: 0,
      endMs: 5000,
    },
    {
      shotId: "sh-002",
      sceneId: "sc-1",
      audioPath: "audio/sh-002.mp3",
      durationMs: 7000,
      startMs: 5000,
      endMs: 12000,
    },
  ],
  cues: [],
};

/** timeline.json v2 夹具：镜头切点 + 旁白 cue。 */
const timelineDoc = {
  fps: 30,
  timingSource: "estimated",
  totalMs: 12000,
  shots: [
    { shotId: "sh-001", sceneId: "sc-1", startMs: 0, endMs: 5000, durationMs: 5000 },
    { shotId: "sh-002", sceneId: "sc-1", startMs: 5000, endMs: 12000, durationMs: 7000 },
  ],
  cues: [{ cueId: "c-1" }, { cueId: "c-2" }],
};

describe("ArtifactTabs v2（L1 / T505）", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    apiRequestMock.mockReset();
    // jsdom 不实现 matchMedia：AntD Table 的响应式观察用恒不命中替身
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
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects/p-1/generations") return { items: [] };
      if (path.includes("copy.json")) return copyDoc;
      if (path.includes("scenes/spec.json")) return sceneDoc;
      if (path.includes("audio/cues.json")) return audioDoc;
      if (path.includes("timeline.json")) return timelineDoc;
      return {};
    });
  });

  afterEach(() => {
    apiRequestMock.mockReset();
  });

  /** 挂载产物面板并等待结构化文档全部拉取完成。 */
  async function mountTabs() {
    const wrapper = mount(ArtifactTabs, {
      props: { artifacts: makeArtifacts(), project: makeProject(), activeTab: "copy" },
      global: { plugins: [pinia, Antd] },
    });
    await vi.waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(([path]) => String(path).includes("timeline.json")),
      ).toBe(true),
    );
    return wrapper;
  }

  test("文案 Tab 按 v2 章节 / 镜头嵌套渲染", async () => {
    const wrapper = await mountTabs();
    expect(wrapper.find(".copy-doc-title").text()).toBe("标题");
    expect(wrapper.text()).toContain("示例主题");
    expect(wrapper.text()).toContain("科普");
    expect(wrapper.text()).toContain("第一章");
    // 镜头嵌套在章节下，而不是 v1 的扁平 narration
    expect(wrapper.findAll(".copy-shots li")).toHaveLength(2);
    expect(wrapper.findAll(".copy-shot-id").map((node) => node.text())).toEqual([
      "sh-001",
      "sh-002",
    ]);
    expect(wrapper.text()).toContain("第一句口播");
  });

  test("场景 Tab 按 SceneSpec 规格表渲染（中文枚举 + 转场 + 动效数）", async () => {
    const wrapper = await mountTabs();
    await wrapper.setProps({ activeTab: "scene" });
    await vi.waitFor(() => expect(wrapper.find(".artifact-scene").exists()).toBe(true));

    const text = wrapper.find(".artifact-scene").text();
    expect(text).toContain("documentary-dark");
    expect(text).toContain("组件版式");
    expect(text).toContain("keyword-block");
    expect(text).toContain("硬切");
    expect(text).toContain("120ms 淡入");
    expect(text).toContain("3");
    // v2 已无 HTML 预览产物，场景面板不再内嵌 iframe
    expect(wrapper.find(".artifact-scene iframe").exists()).toBe(false);
  });

  test("时间轴 Tab 按 v2 镜头切点渲染概要", async () => {
    const wrapper = await mountTabs();
    await wrapper.setProps({ activeTab: "timeline" });
    await vi.waitFor(() => expect(wrapper.find(".artifact-timeline").exists()).toBe(true));

    const text = wrapper.find(".artifact-timeline").text();
    expect(text).toContain("00:12");
    expect(text).toContain("30fps");
    expect(text).toContain("字速估算（降级）");
    expect(text).toContain("旁白 cue：2 条");
  });

  test("音频 Tab 以 cues 镜头切点为索引并上报镜头级重生成", async () => {
    const wrapper = await mountTabs();
    await wrapper.setProps({ activeTab: "audio" });
    await vi.waitFor(() => expect(wrapper.findAll(".audio-item").length).toBe(2));

    expect(wrapper.findAll(".audio-name").map((node) => node.text())).toEqual(["sh-001", "sh-002"]);
    expect(wrapper.text()).toContain("时长 00:05");

    const regenerate = wrapper
      .findAll(".audio-item button")
      .find((button) => button.text().includes("重新配音"));
    expect(regenerate).toBeTruthy();
    await regenerate!.trigger("click");
    expect(wrapper.emitted("regenerate")?.[0]).toEqual([{ stage: "tts", shotId: "sh-001" }]);
  });
});
