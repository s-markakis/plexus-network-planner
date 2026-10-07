// Playwright E2E config. Tests live in tests/e2e/*.spec.js — kept distinct
// from the Vitest unit tests (tests/**/*.test.js) so the two runners never
// pick up each other's files. The dev server is started automatically.
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Ignore macOS AppleDouble shadow files (`._*`) that exFAT PandorasBox grows —
  // they're not JS and would fail to parse as test files.
  testIgnore: '**/._*',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', {open: 'never'}]]
    : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
