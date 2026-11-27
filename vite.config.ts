import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { appVersion } from "./scripts/version.mjs";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "help", test: /\/src\/help\/|\/node_modules\/marked\// }],
        },
      },
    },
  },
});
