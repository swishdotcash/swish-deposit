import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Reuse API, passkey, and wallet clients. The demo owns its widget copy.
    alias: {
      core: fileURLToPath(new URL("../../packages/js/src", import.meta.url)),
    },
  },
  // 5173 is the page address the demo app registered for local work.
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:5183", changeOrigin: false } },
  },
});
