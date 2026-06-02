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
  },
});
