// Regenerates the README screenshots and the demo GIF (docs/media/) from the
// running app, in the dark theme: `npm run docs:media`. Not part of the test
// suites — it only produces images.
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './scripts/media',
  testMatch: '**/*.spec.js',
  testIgnore: '**/._*',
  workers: 1,
  reporter: 'list',
  timeout: 120000,
  use: {baseURL: 'http://localhost:5173'},
  webServer: {command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60000},
});
