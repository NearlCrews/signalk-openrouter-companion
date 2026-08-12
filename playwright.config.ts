import { defineConfig, devices } from '@playwright/test';
import { browserFixturePort } from './fixtures/browser/server-port';

const browserFixtureUrl = `http://127.0.0.1:${browserFixturePort}`;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: browserFixtureUrl,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'vite --config fixtures/browser/vite.config.ts',
    url: browserFixtureUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', grepInvert: /@coarse/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', grepInvert: /@coarse/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grepInvert: /@coarse/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
