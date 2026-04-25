import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import crossOriginIsolation from "vite-plugin-cross-origin-isolation";
import { resolve } from "path";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            if (id.includes("@opendaw/studio-core")) return "opendaw-core";
            if (id.includes("@opendaw/studio-boxes")) return "opendaw-boxes";
            if (id.includes("@opendaw/studio-adapters")) return "opendaw-adapters";
            if (id.includes("@opendaw/lib-")) return "opendaw-libs";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: "localhost",
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    port: 4173,
    host: "localhost",
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  plugins: [react(), crossOriginIsolation()],
});
