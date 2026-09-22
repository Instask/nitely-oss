import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup/realpath-tmpdir.ts"],
    // Process-heavy integration tests can approach 20s under full worker contention.
    testTimeout: 30_000,
    exclude: [
      ...configDefaults.exclude,
      "**/.nitely/**",
      "**/.nightly/**",
      "**/.worktrees/**",
      "**/.pnpm-store/**",
    ],
    restoreMocks: true,
  },
});
