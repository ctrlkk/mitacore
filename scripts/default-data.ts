import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "fflate";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(projectRoot, "references", "default-data");
const outputPath = resolve(process.argv[2] ?? resolve(projectRoot, "references", "default-data.zip"));

async function collectFiles(directory: string, files: Record<string, Uint8Array> = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const archivePath = relative(sourceDir, path).split(sep).join("/");
    // manifest 仅用于标识默认数据版本，不应写入用户的数据目录。
    if (archivePath === "manifest.json") continue;
    files[archivePath] = await readFile(path);
  }
  return files;
}

const files = await collectFiles(sourceDir);
const archive = await new Promise<Uint8Array>((resolveArchive, rejectArchive) => {
  zip(files, { level: 9 }, (error, data) => {
    if (error) rejectArchive(error);
    else resolveArchive(data);
  });
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, archive);
console.info(`已打包默认数据: ${outputPath}`);
