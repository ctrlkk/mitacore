import { defineConfig, presetWind3 } from "unocss";

export default defineConfig({
  presets: [presetWind3()],
  rules: [
    ["b-ui", { border: "1px solid #e3e6eb" }],
    ["bb-ui", { "border-bottom": "1px solid #e3e6eb" }],
    ["b-success", { border: "1px solid #d3e4dc" }],
  ],
  theme: {
    colors: {
      ink: "#17212b",
      muted: "#71808e",
      line: "#e3e6eb",
      field: "#d3dbe1",
      brand: "#176c58",
      "brand-dark": "#105543",
    },
    fontFamily: {
      sans: '"Noto Sans SC", sans-serif',
      mono: '"DM Mono", "Noto Sans SC", monospace',
    },
  },
});
