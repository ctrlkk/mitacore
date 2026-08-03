import { resolve } from "node:path";
import { defineConfig } from "vite";
import { isRuntimeExternal } from "./build/runtime-dependencies.js";

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: true,
    target: "es2022",
    minify: true,
    rollupOptions: {
      input: {
        server: resolve(import.meta.dirname, "src/server.ts"),
        "html-renderer": resolve(import.meta.dirname, "src/html-renderer.ts"),
      },
      external: isRuntimeExternal,
      output: {
        entryFileNames: "entries/[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        format: "es",
      },
    },
  },
});
