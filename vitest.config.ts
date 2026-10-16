import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/helpers/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ["test/unit/**/*.test.ts", "test/api/**/*.test.ts", "test/e2e/**/*.test.ts"],
  },
});
