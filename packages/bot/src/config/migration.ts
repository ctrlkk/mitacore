import { parse } from "smol-toml";
import type { Config } from "./index";

export async function migrateLegacyTomlConfig(
  raw: string,
  legacyTomlPath: string,
  jsoncPath: string,
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
    await writeConfigFile(validated, jsoncPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`迁移配置写入失败 ${jsoncPath}：${message}`);
  }
  return validated;
}
