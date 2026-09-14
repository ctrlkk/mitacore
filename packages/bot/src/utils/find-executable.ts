import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { binPath } from "@/utils/path";

/**
 * 查找可执行文件，优先使用打包目录的 bin，找不到时回退到系统 PATH
 */
export function findExecutable(name: string): string | null {
  const bundled = binPath(`${name}${process.platform === "win32" ? ".exe" : ""}`);
  try {
    accessSync(bundled, constants.X_OK);
    if (statSync(bundled).isFile()) return bundled;
  } catch {}

  // .cmd/.bat 需要 shell 才能执行，而调用方统一使用 shell: false。
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];

  return (
    [...(process.platform === "win32" ? [process.cwd()] : []), ...(process.env.PATH || "").split(delimiter)]
      .flatMap((rawPath) => {
        const path = /^".*"$/.test(rawPath) ? rawPath.slice(1, -1) : rawPath;
        return extensions.map((ext) => resolve(path, `${name}${ext}`));
      })
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      }) ?? null
  );
}
