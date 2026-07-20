import { join, parse } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { dataPath } from "./utils/path";

const stickersDir = dataPath("references", "stickers");

export async function getStickers() {
  const files = await readdir(stickersDir);
  const webpFiles = files.filter((f) => f.endsWith(".webp") && !f.endsWith(".webp.txt"));

  return await Promise.all(
    webpFiles.map(async (file) => {
      const name = parse(file).name;
      const description = await readFile(join(stickersDir, `${name}.webp.txt`), "utf-8");
      return {
        name,
        description: description.trim(),
      };
    }),
  ).then((stickers) => stickers.sort((a, b) => a.name.localeCompare(b.name)));
}

if (import.meta.main) {
  const stickers = await getStickers();
  const output = stickers
    .map(({ name, description }) => {
      return (
        `<sticker>\n` +
        `  <name>${name}</name>\n` +
        `  <description>\n` +
        `    ${description}\n` +
        `  </description>\n` +
        `</sticker>`
      );
    })
    .join("\n");

  const prompt = `<stickers>\n` + `从下面选择合适的 sticker\n` + `${output}\n` + `</stickers>\n`;

  console.log(prompt);
}
