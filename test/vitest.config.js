// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './test/coverage',
      include: [
        'temporal_api.utils.js',
        'notification.service.js',
        'config.js',
        'controllers.js',
        'scheduler.js',
      ],
      exclude: [
        'node_modules/**',
        'test/**',
        '**/*.http',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});