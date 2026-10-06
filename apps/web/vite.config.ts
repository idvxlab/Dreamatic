import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep application bundles separate from DreamaticArt's /assets/* design-output API.
    assetsDir: "ui",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4310",
      "/assets": "http://localhost:4310",
    },
  },
});
