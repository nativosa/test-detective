import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  // No local retries: flaky failures should surface, not be hidden.
  retries: isCI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    // Machine-readable results for the future investigation agent.
    ['json', { outputFile: 'artifacts/results.json' }],
  ],
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'https://the-internet.herokuapp.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
