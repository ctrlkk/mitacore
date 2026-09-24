import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { Config } from "./index";

export async function migrateLegacyTomlConfig(
  raw: string,
  legacyTomlPath: string,
  jsonPath: string,
  validateConfig: (input: unknown) => Config,
  writeConfigFile: (validated: Config, path: string) => Promise<void>,
): Promise<Config> {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    throw new Error(`旧 TOML 配置文件解析失败：${legacyTomlPath}`);
  }

  const validated = validateConfig(parsed);
  try {
    await writeConfigFile(validated, jsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`迁移配置写入失败 ${jsonPath}：${message}`);
  }
  try {
    await unlink(legacyTomlPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`迁移后删除旧 TOML 配置文件失败 ${legacyTomlPath}：${message}`);
  }
  const exampleTomlPath = join(dirname(legacyTomlPath), "config.example.toml");
  try {
    await unlink(exampleTomlPath);
  } catch (error) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`迁移后删除旧 TOML 示例文件失败 ${exampleTomlPath}：${message}`);
    }
  }
  return validated;
}
