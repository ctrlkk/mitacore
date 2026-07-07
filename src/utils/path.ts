import { resolve } from "node:path";

/**
 * 获取数据目录下的路径
 * @param segments 路径片段
 * @returns 完整路径
 */
export function dataPath(...segments: string[]) {
  return resolve("data", ...segments);
}
