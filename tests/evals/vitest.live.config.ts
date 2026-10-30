import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only for `npm run eval:live`. The default config (vitest.config.ts) never includes tests/evals.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "server-only": fileURLToPath(new URL("../support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/evals/live.eval.ts"],
  },
});
