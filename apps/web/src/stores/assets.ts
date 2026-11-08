import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiRequest } from "../services/api";

/** 服务端项目资产视图。 */
export interface ProjectAsset {
  id: string;
  project_id: string;
  source: "generated" | "uploaded";
  kind: "document" | "image" | "audio" | "copy" | "scene" | "timeline" | "video" | "frames";
  /** 素材库 6 类分类（T118；旧数据可能为 null）。 */
  visual_category?: string | null;
  label: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  /** 已绑定镜头数（T118，由 copy v2 计算）。 */
  boundShots?: number;
  run_id?: string | null;
  stage?: string | null;
  created_at: string;
}

/** 项目资产加载、上传与筛选状态。 */
export const useAssetsStore = defineStore("assets", () => {
  const items = ref<ProjectAsset[]>([]);
  /** 服务端返回的 6 类分类枚举（T118）。 */
  const categories = ref<string[]>([]);
  const loading = ref(false);
  const uploading = ref(false);
  const query = ref("");
  const kindFilter = ref<string>("");

  const filteredItems = computed(() => {
    const keyword = query.value.trim().toLowerCase();
    return items.value.filter(
      (asset) =>
        (!kindFilter.value || asset.kind === kindFilter.value) &&
        (!keyword || asset.label.toLowerCase().includes(keyword)),
    );
  });

  /** 加载指定项目全部资产。 */
  async function load(projectId: string): Promise<void> {
    loading.value = true;
    try {
      const result = await apiRequest<{ items: ProjectAsset[]; categories?: string[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/assets`,
      );
      items.value = result.items;
      categories.value = result.categories ?? [];
    } finally {
      loading.value = false;
    }
  }

  /** 上传文件并合并服务端确认后的资产。 */
  async function upload(projectId: string, file: File): Promise<ProjectAsset> {
    const formData = new FormData();
    formData.append("file", file);
    uploading.value = true;
    try {
      const result = await apiRequest<{ asset: ProjectAsset }>(
        `/api/projects/${encodeURIComponent(projectId)}/assets/upload`,
        { method: "POST", body: formData },
      );
      items.value = [...items.value.filter((item) => item.id !== result.asset.id), result.asset];
      return result.asset;
    } finally {
      uploading.value = false;
    }
  }

  return { items, categories, loading, uploading, query, kindFilter, filteredItems, load, upload };
});
