import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The deposit logic is shared with the package apps install.
    alias: { core: fileURLToPath(new URL("../../packages/js/src", import.meta.url)) },
  },
  build: {
    rollupOptions: {
      // The frame, and the window it opens to create a passkey.
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        passkey: fileURLToPath(new URL("passkey.html", import.meta.url)),
      },
    },
  },
  server: { port: 5174, strictPort: true },
});
