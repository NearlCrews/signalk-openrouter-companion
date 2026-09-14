import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  configFile: resolve('fixtures/browser/vite.config.ts'),
  logLevel: 'warn',
});
await server.listen();

const fixtureUrl = server.resolvedUrls?.local[0];
if (!fixtureUrl) {
  await server.close();
  throw new Error('The browser fixture server did not expose a local URL');
}

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(new URL('?screenshots', fixtureUrl).href);
  await page.locator('body[data-fixture-ready="true"]').waitFor();
  await page.getByRole('heading', { name: 'Live status' }).waitFor();

  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });
  // Blur before scrolling: the theme selector sits at the foot of the panel,
  // so the radio that was just clicked keeps focus, and the browser scrolls a
  // focused control back into view after a re-render. Without the blur the
  // capture ends up at the bottom of the page and the live status grid, which
  // is what these shots are for, never appears.
  const captureViewport = async (path) => {
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => window.scrollY === 0);
    await page.mouse.move(0, 0);
    await page.screenshot({ animations: 'disabled', caret: 'hide', path });
  };

  await themeGroup.getByRole('radio', { name: 'Light' }).click();
  await captureViewport('assets/screenshots/panel-overview.png');

  await themeGroup.getByRole('radio', { name: 'Dark' }).click();
  await captureViewport('assets/screenshots/panel-overview-dark.png');

  await themeGroup.getByRole('radio', { name: 'Night' }).click();
  await captureViewport('assets/screenshots/panel-overview-night.png');

  await themeGroup.getByRole('radio', { name: 'Light' }).click();

  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  await page.getByRole('button', { name: 'Analyzers', exact: true }).click();
  await page.getByRole('button', { name: /Maintenance Advisor/ }).click();
  await page.locator('[data-panel-action-bar]').evaluate((element) => {
    element.style.display = 'none';
  });
  const analyzerSection = page.locator('#orc-section-analyzers');
  await analyzerSection.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.mouse.move(0, 0);
  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: 'assets/screenshots/panel-analyzers.png',
  });
} finally {
  await browser?.close();
  await server.close();
}
