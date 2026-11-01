import { resolve } from "node:path";
import { assertInsideUserRoot, validateProjectName } from "@videoforge/pipeline";

/**
 * 计算某个用户某个项目的落盘目录（见设计文档 §8.3 目录布局）。
 * 布局：`storage/users/<userId>/projects/<项目名>/`；`userId` 用服务端生成的 UUID。
 * 项目名先经 `validateProjectName` 归一化与校验，再由 `assertInsideUserRoot` 复核未越出用户根目录，
 * **不使用字符串拼接构造敏感路径**。
 * @param storageRoot 存储根目录
 * @param userId 用户 ID（UUID）
 * @param name 用户输入的项目名
 * @returns 该项目的绝对目录路径
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) 项目名非法或目标越出用户根目录时
 */
export function resolveUserProjectDir(storageRoot: string, userId: string, name: string): string {
  const safeName = validateProjectName(name);
  const userRoot = resolve(storageRoot, "users", userId);
  const target = resolve(userRoot, "projects", safeName);
  assertInsideUserRoot(userRoot, target);
  return target;
}
