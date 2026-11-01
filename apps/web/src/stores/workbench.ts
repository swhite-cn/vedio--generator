/**
 * 工作台 store（Web 专题 §5.4、§7.1、§7.2）。
 *
 * 职责：装载当前项目 / 会话 / 当前 run / 产物索引，订阅会话 SSE，并把每一帧事件交给纯
 * reducer（`workbench-reducer.ts`，§7.2 唯一权威落点）推进状态；**副作用集中在本文件**：
 * 全局 `message` 提示、产物面板局部刷新、`resync` 全量重拉、项目状态自愈。
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { message } from "ant-design-vue";
import { apiRequest, formatApiError } from "../services/api";
import { subscribeSessionEvents, type SseFrame } from "../services/sse";
import type { Project } from "./projects";
import {
  applyEvent,
  createInitialState,
  sevenStages,
  toStageProgress,
  type ArtifactIndex,
  type RunSummary,
  type SessionSummary,
  type WorkbenchState,
} from "./workbench-reducer";

/** 服务端 `GET /api/runs/:id` 返回的阶段行（snake_case，字段见主文档 §11 `run_stages`）。 */
type ServerStageRow = {
  stage: string;
  status: string;
  attempt: number;
  error_code?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
};

/** 本地乐观消息自增序号（避免与服务端 / reducer 生成的 id 冲突）。 */
let localSeq = 0;

/**
 * 生成本地乐观消息 id。
 * @param prefix 前缀（如 `user`）
 * @returns 全局唯一的本地消息 id
 */
function nextLocalId(prefix: string): string {
  localSeq += 1;
  return `${prefix}-local-${localSeq}`;
}

export const useWorkbenchStore = defineStore("workbench", () => {
  /** 工作台完整状态（由纯 reducer 推进）。 */
  const state = ref<WorkbenchState>(createInitialState());
  /** 首次装载 / 重拉中。 */
  const loading = ref(false);
  /** 装载失败（供页面渲染 Result 重试）。 */
  const loadError = ref<unknown>(null);
  /** 用户消息发送中。 */
  const sending = ref(false);
  /** 页头动作（发起 / 取消 run）进行中。 */
  const actionPending = ref(false);

  /** 当前项目 id（SSE / 重拉用）。 */
  let currentProjectId = "";
  /** SSE 退订函数。 */
  let unsubscribe: (() => void) | null = null;

  const project = computed(() => state.value.project);
  const session = computed(() => state.value.session);
  const currentRun = computed(() => state.value.currentRun);
  const stages = computed(() => state.value.stages);
  const artifacts = computed(() => state.value.artifacts);
  const messages = computed(() => state.value.messages);
  const connection = computed(() => state.value.connection);
  const agentStreaming = computed(() => state.value.agentStreaming);
  const finalReady = computed(() => state.value.finalReady);

  /**
   * run 是否处于活跃态。前端唯一允许的派生（§7.3）：仅用于「发起 run」按钮禁用等纯展示逻辑。
   */
  const runActive = computed(() => {
    const status = state.value.currentRun?.status;
    return status === "queued" || status === "running" || status === "waiting_review";
  });

  /**
   * 重新拉取当前 run 详情与阶段进度（关键动作后自愈）。
   */
  async function refreshRun(): Promise<void> {
    const runId = state.value.currentRun?.id;
    if (!runId) return;
    const detail = await apiRequest<{ run: RunSummary; stages: ServerStageRow[] }>(
      `/api/runs/${encodeURIComponent(runId)}`,
    );
    state.value = {
      ...state.value,
      currentRun: detail.run,
      stages: toStageProgress(detail.stages),
    };
  }

  /**
   * 重新拉取项目详情与产物索引（产物面板局部刷新，同时刷新项目状态）。
   */
  async function refreshProjectArtifacts(): Promise<void> {
    if (!currentProjectId) return;
    const detail = await apiRequest<{ project: Project; artifacts: ArtifactIndex }>(
      `/api/projects/${encodeURIComponent(currentProjectId)}`,
    );
    state.value = { ...state.value, project: detail.project, artifacts: detail.artifacts };
  }

  /**
   * 拉取项目详情 / 会话 / 最近 run / run 详情，并整体重置工作台状态（不订阅 SSE）。
   * @param projectId 项目 id
   */
  async function fetchAll(projectId: string): Promise<void> {
    const detail = await apiRequest<{ project: Project; artifacts: ArtifactIndex }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    const sessionResult = await apiRequest<{ sessions: SessionSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    );
    const runResult = await apiRequest<{ runs: RunSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
    );

    const previousConnection = state.value.connection;
    const next = createInitialState();
    next.project = detail.project;
    next.artifacts = detail.artifacts;
    // 本期单会话：取首个（Web 专题 §10 契约对照）
    next.session = sessionResult.sessions[0] ?? null;
    next.currentRun = runResult.runs[0] ?? null;
    next.connection = previousConnection;
    state.value = next;

    if (next.currentRun) {
      try {
        await refreshRun();
      } catch (error) {
        console.warn("[web-store] 拉取 run 详情失败", error);
      }
    }
  }

  /**
   * 装载工作台：重置状态 → 拉取数据 → 订阅会话 SSE。
   * @param projectId 项目 id
   */
  async function load(projectId: string): Promise<void> {
    disposeSse();
    currentProjectId = projectId;
    loading.value = true;
    loadError.value = null;
    try {
      await fetchAll(projectId);
      if (state.value.session) {
        subscribe(state.value.session.id);
      }
      console.info(`[web-store] 工作台已加载：${projectId}`);
    } catch (error) {
      loadError.value = error;
      throw error;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 收到 `resync`：丢弃缓存并全量重拉（重新签票建连）。
   */
  async function resync(): Promise<void> {
    if (!currentProjectId) return;
    console.info("[web-store] 收到 resync，全量重拉工作台数据");
    try {
      await load(currentProjectId);
    } catch (error) {
      console.warn("[web-store] resync 重拉失败", error);
    }
  }

  /**
   * 订阅会话事件流。
   * @param sessionId 会话 id
   */
  function subscribe(sessionId: string): void {
    unsubscribe = subscribeSessionEvents({
      sessionId,
      onEvent: handleFrame,
      onStatus: (status) => {
        state.value = { ...state.value, connection: status.state };
        if (status.state === "disconnected") {
          console.warn("[web-store] 实时连接已断开，正在重试");
        }
      },
    });
  }

  /** 关闭 SSE 订阅。 */
  function disposeSse(): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  /**
   * 单帧事件落点：先经纯 reducer 推进状态，再统一执行副作用。
   * @param frame SSE 帧
   */
  function handleFrame(frame: SseFrame): void {
    const previous = state.value;
    const next = applyEvent(previous, frame);
    state.value = next;

    // error → 全局提示（§7.2）
    if (next.lastError && next.lastError !== previous.lastError) {
      message.error(`操作失败：${next.lastError.message}（${next.lastError.code}）`);
      state.value = { ...state.value, lastError: null };
    }
    // tool_end / run_stage(done) / run_end(done) → 产物面板局部刷新
    if (next.artifactRefreshToken !== previous.artifactRefreshToken) {
      void refreshProjectArtifacts().catch((error) =>
        console.warn("[web-store] 产物面板刷新失败", error),
      );
    }
    // resync → 全量重拉
    if (next.needsResync && !previous.needsResync) {
      void resync();
    }
    if (frame.type === "review_gate") {
      message.info("已到审核点，请在对话流中确认");
    }
    if (frame.type === "run_end") {
      const status = next.currentRun?.status;
      if (status === "failed") {
        const code = next.currentRun?.error_code;
        message.error(`运行失败${code ? `（${code}）` : ""}`);
      } else if (status === "canceled") {
        void refreshProjectArtifacts().catch(() => undefined);
      }
    }
  }

  /**
   * 发送用户消息（乐观追加用户气泡，随后交给服务端对话端口）。
   * @param text 消息文本
   */
  async function sendMessage(text: string): Promise<void> {
    const sessionId = state.value.session?.id;
    const trimmed = text.trim();
    if (!sessionId || trimmed.length === 0) return;

    state.value = {
      ...state.value,
      messages: [
        ...state.value.messages,
        { id: nextLocalId("user"), kind: "user", text: trimmed, at: new Date().toISOString() },
      ],
    };
    sending.value = true;
    try {
      await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: { text: trimmed },
      });
    } catch (error) {
      message.error(formatApiError(error));
      throw error;
    } finally {
      sending.value = false;
    }
  }

  /**
   * 发起 run（`POST /api/projects/:id/runs`）；`PROJECT_BUSY` / `RUN_STATE_INVALID` 按 §8 自愈。
   */
  async function startRun(): Promise<void> {
    if (!currentProjectId) return;
    actionPending.value = true;
    try {
      const result = await apiRequest<{ run: RunSummary }>(
        `/api/projects/${encodeURIComponent(currentProjectId)}/runs`,
        { method: "POST" },
      );
      state.value = {
        ...state.value,
        currentRun: result.run,
        stages: sevenStages(),
        finalReady: false,
      };
      await refreshRun();
      console.info(`[web-store] 已发起 run：${result.run.id}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PROJECT_BUSY") {
        message.error("该项目有任务正在运行");
        await refreshRun().catch(() => undefined);
      } else if (code === "RUN_STATE_INVALID") {
        message.error(formatApiError(error));
        await load(currentProjectId).catch(() => undefined);
      } else {
        message.error(formatApiError(error));
      }
      throw error;
    } finally {
      actionPending.value = false;
    }
  }

  /**
   * 取消当前活跃 run；`RUN_STATE_INVALID` 时提示并重拉自愈。
   */
  async function cancelRun(): Promise<void> {
    const runId = state.value.currentRun?.id;
    if (!runId) return;
    actionPending.value = true;
    try {
      const result = await apiRequest<{ run: RunSummary }>(
        `/api/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      state.value = { ...state.value, currentRun: result.run };
      console.info(`[web-store] 已取消 run：${runId}`);
    } catch (error) {
      const errorCode = (error as { code?: string }).code;
      message.error(formatApiError(error));
      if (errorCode === "RUN_STATE_INVALID" && currentProjectId) {
        await load(currentProjectId).catch(() => undefined);
      }
      throw error;
    } finally {
      actionPending.value = false;
    }
  }

  /**
   * 提交审核结论（`POST /api/runs/:id/resume`），并标记对应审核卡片已提交（置灰）。
   * @param messageId 审核卡片所在消息 id
   * @param action 结论：通过继续 / 重跑此阶段
   * @param feedback 可选反馈（重跑时）
   */
  async function resumeRun(
    messageId: string,
    action: "approve" | "retry",
    feedback?: string,
  ): Promise<void> {
    const runId = state.value.currentRun?.id;
    if (!runId) throw new Error("当前没有可操作的 run");
    const body: { action: string; feedback?: string } = { action };
    if (feedback && feedback.length > 0) body.feedback = feedback;
    await apiRequest(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body });
    state.value = {
      ...state.value,
      messages: state.value.messages.map((item) =>
        item.id === messageId && item.review
          ? { ...item, review: { ...item.review, resolved: action, feedback } }
          : item,
      ),
    };
    console.info(`[web-store] 已提交审核结论：${action}`);
  }

  /**
   * 中断当前自由对话轮（`POST /api/sessions/:id/abort`）。
   */
  async function abortChat(): Promise<void> {
    const sessionId = state.value.session?.id;
    if (!sessionId) return;
    try {
      await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
      console.info("[web-store] 已请求中断当前对话轮");
    } catch (error) {
      message.error(formatApiError(error));
    }
  }

  /** 离开页面时释放订阅与本地引用。 */
  function dispose(): void {
    disposeSse();
    currentProjectId = "";
  }

  return {
    state,
    loading,
    loadError,
    sending,
    actionPending,
    project,
    session,
    currentRun,
    stages,
    artifacts,
    messages,
    connection,
    agentStreaming,
    finalReady,
    runActive,
    load,
    dispose,
    refreshRun,
    refreshProjectArtifacts,
    sendMessage,
    startRun,
    cancelRun,
    resumeRun,
    abortChat,
  };
});
