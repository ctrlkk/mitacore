import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const outputPath = fileURLToPath(new URL("../dist/app.mjs", import.meta.url));
const source = await readFile(outputPath, "utf8");
const result = JavaScriptObfuscator.obfuscate(source, {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  ignoreImports: true,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  sourceMap: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.5,
  target: "node",
});

await writeFile(outputPath, result.getObfuscatedCode());
