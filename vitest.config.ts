import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/queue.ts",
        "src/retry.ts",
        "src/transport.ts",
        "src/middleware.ts",
        "src/client.ts",
      ],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
