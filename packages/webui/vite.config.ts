import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";

export default defineConfig({
  plugins: [react(), UnoCSS()],
  build: {
    minify: "esbuild",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:14251",
    },
  },
});
