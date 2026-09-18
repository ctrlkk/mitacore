import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { configSchema } from "../src/config";
import { projectPath } from "../src/utils/path";

const outputPath = process.argv[2] ? resolve(process.argv[2]) : projectPath("config.schema.json");
const jsonSchema = z.toJSONSchema(configSchema, { io: "input" });

// $schema 只用于编辑器关联，不属于运行时业务配置。
jsonSchema.properties = {
  $schema: { type: "string", description: "配置文件使用的 JSON Schema 地址" },
  ...jsonSchema.properties,
};

await writeFile(outputPath, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
console.log(`配置 Schema 已生成：${outputPath.replaceAll("\\", "/")}`);
