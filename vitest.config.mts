import { defineConfig } from 'vitest/config';
import path from 'node:path';

const vscodeMock = path.resolve(import.meta.dirname, 'test/mocks/vscode.ts');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          alias: { vscode: vscodeMock },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          alias: { vscode: vscodeMock },
          pool: 'forks',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
