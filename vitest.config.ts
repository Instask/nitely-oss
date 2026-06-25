import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup/realpath-tmpdir.ts"],
    testTimeout: 20_000,
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
