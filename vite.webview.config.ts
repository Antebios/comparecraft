import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { appVersion } from "./scripts/version.mjs";

// Embedded text compare for the VS Code extension: one script and one stylesheet with stable
// names, loaded by an extension-generated page with a strict Content Security Policy.
export default defineConfig({
  plugins: [solid()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  base: "./",
  publicDir: false,
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./extensions/vscode/media/webview", import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/webview/main.tsx", import.meta.url)),
      output: {
        codeSplitting: false,
        entryFileNames: "webview.js",
        assetFileNames: "webview[extname]",
      },
    },
  },
});
