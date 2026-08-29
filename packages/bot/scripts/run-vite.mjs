import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root: packageRoot,
  configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
  appType: "custom",
  server: {
    hmr: watch,
    middlewareMode: true,
    watch: watch ? undefined : null,
  },
});

try {
  await server.ssrLoadModule("/src/index.ts");
  if (watch) await new Promise(() => {});
} finally {
  await server.close();
}
