import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.getByRole('heading', { name: 'Live status' })).toBeVisible();
});

test('loads the production remote and completes the save flow', async ({ page }) => {
  const panelRoot = page.locator('[data-snui-root]');
  await expect(panelRoot).toHaveAttribute('data-snui-version', '0.4.1');
  await expect(panelRoot).toHaveAttribute('data-snui-theme', 'light');
  await expect(page.getByText('12,480')).toBeVisible();
  const maintenanceSection = page.getByRole('button', { name: /Maintenance Advisor/ });
  await expect(maintenanceSection).toHaveCount(0);

  await page.getByRole('button', { name: 'Analyzers' }).click();
  await expect(maintenanceSection).toBeVisible();
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await expect(maintenanceSection).toBeHidden();

  await page.getByRole('button', { name: 'Add API key' }).click();
  const apiKey = page.getByRole('textbox', { name: 'API key', exact: true });
  await expect(apiKey).toBeFocused();
  await expect(apiKey).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter an OpenRouter API key.')).toBeVisible();
  await apiKey.fill('   ');

  const saveButton = page
    .locator('[data-panel-action-bar]')
    .locator('button', { hasText: 'Save configuration' });
  await saveButton.click();
  await expect(apiKey).toBeFocused();
  await expect(page.getByText('Enter an OpenRouter API key before saving.')).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-save-count', /\d/);

  await apiKey.fill('fixture-key');
  await expect(apiKey).not.toHaveAttribute('aria-invalid');
  await expect(page.getByText('OpenRouter setup required')).toBeHidden();

  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.focus();
  await expect(page.locator('body')).toHaveAttribute('data-model-request-count', '1');
  await apiKey.focus();
  await model.focus();
  await expect(page.locator('body')).toHaveAttribute('data-model-request-count', '1');
  await expect(page.getByText('2 models available')).toBeVisible();
  await apiKey.focus();
  await model.focus();
  await expect(page.locator('body')).toHaveAttribute('data-model-request-count', '1');

  await page.getByRole('button', { name: 'QuestDB enrichment' }).click();
  const questdbUrl = page.getByRole('textbox', { name: 'QuestDB REST URL', exact: true });
  await questdbUrl.fill('ftp://questdb.local');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await questdbUrl.fill('http://questdb.local:9000?token=secret');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await saveButton.click();
  await expect(questdbUrl).toBeFocused();
  await expect(
    page.getByText('Enter an HTTP or HTTPS base URL without a query or fragment.'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Enter a valid QuestDB HTTP or HTTPS base URL without a query or fragment before saving.',
    ),
  ).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-save-count', /\d/);
  await questdbUrl.fill('http://localhost:9000');

  await saveButton.click();
  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /fixture-key/);
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1');
  expect(await saveButton.evaluate((element) => element.hasAttribute('disabled'))).toBe(false);
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('aria-busy', 'true');
  await expect(saveButton).toHaveAccessibleName('Saving: Save configuration');
  const saveStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]');
  await expect(saveStatus).toBeFocused();
  await expect(saveStatus).toContainText('Plugin restarting');

  await saveButton.dispatchEvent('click');
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1');

  await page.evaluate(() => document.dispatchEvent(new Event('fixture-host-resync')));
  await expect(page.locator('body')).toHaveAttribute('data-host-resync-count', '1');
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).not.toHaveAttribute('aria-busy');
  await expect(page.getByText(/Plugin restarted\./)).toBeVisible();
  await expect(saveStatus).toBeFocused();
  await expect(saveStatus).toContainText('Plugin restarted');
});

test('gives repeated analyzer controls unique accessible names', async ({ page }) => {
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await page.getByRole('button', { name: /Maintenance Advisor/ }).click();

  await expect(page.getByRole('checkbox', { name: 'Maintenance Advisor: Enabled' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Fire now for Maintenance Advisor' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'View reports for Maintenance Advisor' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit prompt for Maintenance Advisor' }),
  ).toBeVisible();
});

test('ignores an older status response that resolves after a newer poll', async ({ page }) => {
  await page.goto('/?status-race');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-status-request-count', '2');

  await page.waitForTimeout(50);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('body')).toHaveAttribute('data-status-request-count', '3');
  await expect(page.locator('body')).toHaveAttribute('data-superseded-status-aborted', 'true');
  await expect(page.getByText('9 / 50', { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  await expect(page.getByText('9 / 50', { exact: true })).toBeVisible();
});

test('defaults a fresh profile to Light without persisting an implicit choice', async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.removeItem('signalk-nearlcrews-ui.theme.v1');
    localStorage.removeItem('orc-theme');
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');

  const root = page.locator('[data-snui-root]');
  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });
  await expect(root).toHaveAttribute('data-snui-theme', 'light');
  await expect(themeGroup.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('orc-theme'))).toBeNull();

  await themeGroup.getByRole('radio', { name: 'Auto' }).click();
  await expect(root).not.toHaveAttribute('data-snui-theme');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBe('auto');
});

test('migrates the legacy preference and supports every theme', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('signalk-nearlcrews-ui.theme.v1');
    localStorage.setItem('orc-theme', 'night');
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.locator('[data-snui-root]')).toHaveAttribute('data-snui-theme', 'night');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBe('night');

  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });
  for (const [label, value] of [
    ['Light', 'light'],
    ['Dark', 'dark'],
    ['Night', 'night'],
  ] as const) {
    await themeGroup.getByRole('radio', { name: label }).click();
    await expect(page.locator('[data-snui-root]')).toHaveAttribute('data-snui-theme', value);
  }
  await themeGroup.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('[data-snui-root]')).not.toHaveAttribute('data-snui-theme');
});

test('has no Axe findings or horizontal overflow at 320 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'OpenRouter' }).click();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('responds to a 320-pixel embedded panel inside a wide host', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('main').evaluate((element) => {
    element.style.width = '320px';
    element.style.padding = '0';
  });
  await page.getByRole('button', { name: 'OpenRouter' }).click();

  const root = page.locator('[data-snui-root]');
  await expect(root).toHaveCSS('width', '320px');
  const overflow = await root.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(page.viewportSize()).toMatchObject({ width: 1280 });
});

test('provides coarse-pointer controls with 44-pixel targets @coarse', async ({ page }) => {
  for (const control of [
    page.getByRole('radio', { name: 'Auto' }),
    page.getByRole('button', { name: 'OpenRouter' }),
    page.getByRole('button', { name: 'Save configuration' }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('shows a compatibility message when native CSS scope is unavailable', async ({ page }) => {
  await page.goto('/?unsupported-css-scope');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.locator('[data-browser-compatibility-message]')).toContainText(
    'Browser update required',
  );
  await expect(page.locator('[data-snui-root]')).toHaveCount(0);
});
