// Playwright config for the DESKTOP app: launches the real Electron build
// (electron/main.cjs + dist/index.html) instead of the dev server, so the
// native bridge — project files, menus, IPC gates — is exercised end to end.
// Needs the single-file build first: `npm run e2e:desktop` does both.
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-desktop',
  testMatch: '**/*.spec.js',
  testIgnore: '**/._*',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60000,
});
