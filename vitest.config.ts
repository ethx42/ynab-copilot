import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Measure ONLY the pure core + ports (QG-03). Adapters/config are impure edges.
      include: ["src/core/**", "src/ports/**"],
      // Seed thresholds — tunable as the core grows (see SUMMARY).
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
