import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    minify: "esbuild",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:14251",
    },
  },
});
