import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'tests/reports/coverage',
      include: ['src/**/*.js'],
      exclude: ['src/config.js'],
    },
    poolOptions: {
      threads: {
        isolate: true,
      },
    },
  },
});
