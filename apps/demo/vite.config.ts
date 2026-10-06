import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The button and the loader are the package apps install.
    alias: { core: fileURLToPath(new URL("../../packages/js/src", import.meta.url)) },
  },
  // 5173 is the page address the demo app registered for local work.
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://localhost:5183" } },
});
