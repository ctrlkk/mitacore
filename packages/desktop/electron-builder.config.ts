import type { Configuration } from "electron-builder";
import { join } from "node:path";

const electronCache = join(process.cwd(), "..", "..", ".electron-cache");

const config: Configuration = {
  appId: "com.mitacore.desktop",
  productName: "MitaCore",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  electronDownload: {
    cache: electronCache,
  },
  files: ["out/**/*"],
  extraResources: [
    {
      from: "../../dist",
      to: "runtime",
    },
  ],
  win: { target: "nsis" },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  mac: { target: "dmg" },
  linux: { target: "AppImage" },
};

export default config;
