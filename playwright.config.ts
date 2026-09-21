import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated-tests',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['json', { outputFile: 'test-results/results.json' }]],
});
