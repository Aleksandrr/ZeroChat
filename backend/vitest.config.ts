import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    // Run all test files sequentially — they share the same PGlite
    // data directory and would race on the filesystem lock otherwise.
    // Vitest 4 rework notes:
    //   - `poolOptions.forks.singleFork` was promoted to top-level
    //     `singleFork`, but in 4.x the config key that actually
    //     disables file parallelism is `fileParallelism: false`.
    //   - `isolate: false` keeps module registries shared across
    //     test files so the PGlite singleton persists.
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
