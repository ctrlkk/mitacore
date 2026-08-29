import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(packageDir, "../..");

export default defineConfig(({ command }) => ({
  resolve: {
    alias: {
      "@": resolve(packageDir, "src"),
      "@prompts": resolve(rootDir, "prompts"),
    },
  },
  ssr: {
    // 开发运行器应交由 Node 加载 CommonJS 依赖；构建产物仍保持完整打包。
    noExternal: command === "build" ? true : undefined,
  },
  build: {
    ssr: true,
    target: "es2022",
    minify: true,
    outDir: resolve(rootDir, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(packageDir, "src/index.ts"),
      output: {
        entryFileNames: "app.mjs",
        format: "es",
        codeSplitting: false,
      },
    },
  },
  define: {
    "import.meta.main": "true",
    __STANDALONE__: JSON.stringify(command === "build"),
  },
}));
