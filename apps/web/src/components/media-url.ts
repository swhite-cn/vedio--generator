/**
 * 媒体访问地址构造（Web 专题 §5.4.4、§5.5；服务端 `/api/media/*` 契约）。
 *
 * 服务端媒体相对路径必须以 `users/<userId>/` 开头（POSIX `/` 分隔），项目目录布局为
 * `users/<userId>/projects/<项目名>/`（见 `apps/server/src/domain/storage-layout.ts`），
 * 因此项目内某产物的媒体地址形如：
 * `/api/media/users/<userId>/projects/<项目名>/<相对项目根路径>`。
 * 一律使用相对路径，不硬编码主机与端口。
 */
import type { Project } from "../stores/projects";

/**
 * 构造项目内某产物文件的媒体访问地址。
 * @param project 所属项目（提供 `user_id` 与 `name`）；缺失时返回空串
 * @param relativePath 相对项目根目录的路径（POSIX `/`，如 `copy.json`、`images/a.png`）
 * @returns 形如 `/api/media/users/<uid>/projects/<name>/<path>` 的相对 URL；入参不全时返回空串
 */
export function buildMediaUrl(project: Project | null | undefined, relativePath: string): string {
  if (!project || !relativePath) {
    return "";
  }
  const user = encodeURIComponent(project.user_id);
  const name = encodeURIComponent(project.name);
  // 逐段编码以保留 `/` 作为路径分隔符（服务端通配参数按 POSIX 分隔还原）
  const encodedPath = relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/media/users/${user}/projects/${name}/${encodedPath}`;
}
