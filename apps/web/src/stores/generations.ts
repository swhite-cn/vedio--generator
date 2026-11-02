import { defineStore } from "pinia";
import { ref } from "vue";
import { apiRequest } from "../services/api";

/**
 * 项目生成上下文（`manifest/generations.jsonl` 的最新一条 / 产物）。
 * 只做展示与"以此为基线重生成"的入口，不在前端推导状态机。
 */
export interface GenerationRecord {
  /** 记录 ID。 */
  id: string;
  /** 产生该记录的阶段。 */
  stage: "copy" | "image" | "scene" | "tts";
  /** 场景 ID（整篇类产物缺省）。 */
  sceneId?: string;
  /** 产物相对项目目录的路径。 */
  assetPath?: string;
  /** 实际调用的模型。 */
  model?: string;
  /** 提示词集名。 */
  promptSet?: string;
  /** 当时实际发送的完整提示词。 */
  prompt?: string;
  /** 是否降级为内置模板。 */
  fallback?: boolean;
  /** 是否成功。 */
  ok: boolean;
  /** 失败错误码。 */
  errorCode?: string;
  /** 失败说明。 */
  errorMessage?: string;
  /** 记录时间。 */
  createdAt: string;
}

/** 生成上下文 store：按项目加载，按阶段 + 场景查询。 */
export const useGenerationStore = defineStore("generations", () => {
  /** 当前项目的生成记录（每个产物一条）。 */
  const items = ref<GenerationRecord[]>([]);
  /** 是否正在加载。 */
  const loading = ref(false);

  /**
   * 加载指定项目的生成上下文。
   * @param projectId 项目 ID
   */
  async function load(projectId: string): Promise<void> {
    loading.value = true;
    try {
      const result = await apiRequest<{ items: GenerationRecord[] }>(
        `/api/projects/${projectId}/generations`,
      );
      items.value = result.items;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 取某阶段某场景的最新生成记录。
   * @param stage 阶段名
   * @param sceneId 场景 ID
   * @returns 命中的记录；没有则 undefined
   */
  function find(stage: GenerationRecord["stage"], sceneId: string): GenerationRecord | undefined {
    return items.value.find((item) => item.stage === stage && item.sceneId === sceneId);
  }

  return { items, loading, load, find };
});
