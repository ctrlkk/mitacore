const { resolve } = require("node:path");
const { defineConfig } = require("vite");

const packageDir = __dirname;
const rootDir = resolve(packageDir, "../..");

module.exports = defineConfig(({ command }) => ({
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
    __STANDALONE__: JSON.stringify(command === "build"),
  },
}));
