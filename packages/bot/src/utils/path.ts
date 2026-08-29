import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const __STANDALONE__: boolean;

const installRoot =
  typeof __STANDALONE__ !== "undefined" && __STANDALONE__
    ? dirname(fileURLToPath(import.meta.url))
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * 获取数据目录下的路径
 * @param segments 路径片段
 * @returns 完整路径
 */
export function dataPath(...segments: string[]) {
  return resolve(installRoot, "data", ...segments);
}

/**
 * 获取打包 node 可执行文件路径
 * @param segments 路径片段
 * @returns 完整路径
 */
export function binPath(...segments: string[]) {
  return resolve(installRoot, "bin", ...segments);
}

/**
 * 获取 sidecar 路径
 * @param segments 路径片段
 * @returns 完整路径
 */
export function sidecarPath(...segments: string[]) {
  return resolve(installRoot, "sidecar", ...segments);
}

/**
 * 相对 installRoot 的自由路径拼接（用于 prod 中可能不存在的 dev 源码 fallback）
 * @param segments 路径片段
 * @returns 完整路径
 */
export function projectPath(...segments: string[]) {
  return resolve(installRoot, ...segments);
}
