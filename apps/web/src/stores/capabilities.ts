/**
 * 能力列表 store（见 Web 专题 §7.1）：应用级缓存 `GET /api/capabilities`，
 * 供能力中心与新建项目 Modal 共用；已加载则复用，避免重复请求。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiRequest } from "../services/api";

/** 阶段产物判据（与主文档 §3.6 的能力声明一致，前端仅消费其中展示所需字段）。 */
export interface CapabilityStageDeclaration {
  stage: string;
  tool: string;
  label: string;
  reviewGate: boolean;
}

/** 创建项目参数声明。 */
export interface CapabilityParamDeclaration {
  name: string;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue?: string;
}

/** 能力只读视图（`GET /api/capabilities` 的 `capabilities[]` 元素）。 */
export interface Capability {
  id: string;
  name: string;
  description: string;
  stages: CapabilityStageDeclaration[];
  reviewGates: string[];
  params: CapabilityParamDeclaration[];
  skillDirs: string[];
  finalArtifact: string;
}

export const useCapabilitiesStore = defineStore("capabilities", () => {
  /** 能力列表缓存。 */
  const list = ref<Capability[]>([]);
  /** 是否正在加载。 */
  const loading = ref(false);
  /** 最近一次加载错误。 */
  const error = ref<unknown>(null);
  /** 是否已成功加载过一次。 */
  const loaded = ref(false);

  /**
   * 加载能力列表；已加载且未强制刷新时直接复用缓存。
   * @param force 为 true 时强制重新请求
   * @returns 能力列表
   */
  async function load(force = false): Promise<Capability[]> {
    if (loaded.value && !force) {
      return list.value;
    }
    loading.value = true;
    error.value = null;
    try {
      const result = await apiRequest<{ capabilities: Capability[] }>("/api/capabilities");
      list.value = result.capabilities;
      loaded.value = true;
      console.info(`[web-store] 能力列表已加载：${list.value.length} 项`);
    } catch (caught) {
      error.value = caught;
      throw caught;
    } finally {
      loading.value = false;
    }
    return list.value;
  }

  /**
   * 按 id 查找已缓存的能力。
   * @param id 能力 id
   * @returns 命中的能力；未命中返回 undefined
   */
  function findById(id: string): Capability | undefined {
    return list.value.find((capability) => capability.id === id);
  }

  return { list, loading, error, loaded, load, findById };
});
