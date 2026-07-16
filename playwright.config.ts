import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'vite --config fixtures/browser/vite.config.ts',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', grepInvert: /@coarse/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', grepInvert: /@coarse/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grepInvert: /@coarse/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
