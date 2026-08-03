import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "com.mitacore.desktop",
  productName: "MitaCore",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*"],
  extraResources: [
    {
      from: "../../dist",
      to: "runtime",
    },
  ],
  win: { target: "nsis" },
  mac: { target: "dmg" },
  linux: { target: "AppImage" },
};

export default config;
