import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Disable Vite's deps optimization so tsx handles ALL module resolution
    server: {
      deps: {
        inline: ['snappy', '@mongodb-js/zstd'],
      },
    },
    // Let tsx handle .js → .ts resolution via Node.js loader
    deps: {
      optimizer: {
        enabled: false,
      },
    },
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',          // re-export barrel
        'src/compaction/worker.ts', // Worker thread entry
      ],
      thresholds: {
        branches: 50,
        functions: 50,
        lines: 50,
        statements: 50,
      },
      watermarks: {
        statements: [50, 85],
        functions: [50, 85],
        branches: [50, 85],
        lines: [50, 85],
      },
    },
  },
});
