import { resolve } from "node:path";
import { defineConfig } from "vite";

const packageDir = import.meta.dirname;
const rootDir = resolve(packageDir, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(packageDir, "src"),
      "@prompts": resolve(rootDir, "prompts"),
    },
  },
  ssr: {
    noExternal: true,
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
    __STANDALONE__: "true",
  },
});
