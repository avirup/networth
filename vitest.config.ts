import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL(".", import.meta.url)),
  "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", environment: "node", include: ["tests/unit/**/*.test.ts"] } },
      { resolve: { alias }, test: {
        name: "integration", fileParallelism: false, environment: "node", include: ["tests/integration/**/*.test.ts"],
        setupFiles: ["./tests/support/integration-env.ts"], testTimeout: 15_000, hookTimeout: 15_000,
      } },
    ],
  },
});
