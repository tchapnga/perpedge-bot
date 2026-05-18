import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      setupFiles: ['tests/setup.unit.ts'],
      testTimeout: 5_000,
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      setupFiles: ['tests/setup.integration.ts'],
      testTimeout: 60_000,
      environment: 'node',
    },
  },
]);
