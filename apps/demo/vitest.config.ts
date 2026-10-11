import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      core: fileURLToPath(new URL("../../packages/js/src", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.{ts,mjs}"], environment: "node" },
});
