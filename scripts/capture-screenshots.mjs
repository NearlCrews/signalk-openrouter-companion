import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  configFile: resolve('fixtures/browser/vite.config.ts'),
  logLevel: 'warn',
});
await server.listen();

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    viewport: { width: 900, height: 1100 },
  });
  await page.goto('http://127.0.0.1:4174/?screenshots');
  await page.locator('body[data-fixture-ready="true"]').waitFor();
  await page.getByRole('heading', { name: 'Live status' }).waitFor();

  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  const panel = page.locator('[data-snui-root]');
  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });

  await themeGroup.getByRole('radio', { name: 'Light' }).click();
  await page.mouse.move(0, 0);
  await panel.screenshot({
    animations: 'disabled',
    path: 'assets/screenshots/panel-overview.png',
  });

  await themeGroup.getByRole('radio', { name: 'Dark' }).click();
  await page.mouse.move(0, 0);
  await panel.screenshot({
    animations: 'disabled',
    path: 'assets/screenshots/panel-overview-dark.png',
  });

  await themeGroup.getByRole('radio', { name: 'Night' }).click();
  await page.mouse.move(0, 0);
  await panel.screenshot({
    animations: 'disabled',
    path: 'assets/screenshots/panel-overview-night.png',
  });

  await themeGroup.getByRole('radio', { name: 'Light' }).click();

  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click();
  await page.getByRole('button', { name: /Maintenance Advisor/ }).click();
  await page.locator('[data-panel-action-bar]').evaluate((element) => {
    element.style.display = 'none';
  });
  await page.mouse.move(0, 0);
  await page.locator('#orc-section-analyzers').screenshot({
    animations: 'disabled',
    path: 'assets/screenshots/panel-analyzers.png',
  });
} finally {
  await browser?.close();
  await server.close();
}
