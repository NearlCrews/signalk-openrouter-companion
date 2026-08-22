import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, test } from '@playwright/test';
import packageJson from '../../package.json' with { type: 'json' };

const EXPECTED_UI_VERSION = packageJson.devDependencies['signalk-nearlcrews-ui'];

// Clicking a control that overlaps the docked action bar can be swallowed: the
// shared UI scrolls a newly focused control clear of the bar, and the pointer
// no longer sits over the control when the mouse comes back up, so no click
// event is dispatched. Focusing first lets that scroll settle, then the click
// lands where the test aimed it.
async function clickClearOfActionBar(control: Locator): Promise<void> {
  await control.focus();
  await control.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.getByRole('heading', { name: 'Live status' })).toBeVisible();
});

test('shows a standalone compatibility alert when native CSS scope is unavailable', async ({
  page,
}) => {
  await page.goto('/?unsupported-css-scope');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');

  const notice = page.getByRole('alert');
  await expect(notice).toHaveAttribute('data-browser-compatibility-message', '');
  await expect(notice).toContainText('Browser update required');
  await expect(notice).toContainText('This panel requires native CSS @scope.');
  await expect(page.locator('[data-snui-root]')).toHaveCount(0);
});

test('loads the production remote and completes the save flow', async ({ page }) => {
  test.setTimeout(90_000);
  const panelRoot = page.locator('[data-snui-root]');
  await expect(panelRoot).toHaveAttribute('data-snui-version', EXPECTED_UI_VERSION);
  await expect(panelRoot).not.toHaveAttribute('data-snui-theme');
  await expect(page.locator('[data-panel-action-bar]')).toHaveClass(
    /snui-action-bar--sticky-viewport-bottom/,
  );
  await expect(page.getByText('12,480')).toBeVisible();
  const maintenanceSection = page.getByRole('button', { name: /Maintenance Advisor/ });
  await expect(maintenanceSection).toHaveCount(0);

  await page.getByRole('button', { name: 'Analyzers' }).click();
  await expect(maintenanceSection).toBeVisible();
  const maintenanceEnabled = page.getByRole('checkbox', {
    name: 'Maintenance Advisor: Enabled',
  });
  await maintenanceEnabled.click();
  await maintenanceEnabled.click();
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await expect(maintenanceSection).toBeHidden();

  await page.getByRole('button', { name: 'Add API key' }).click();
  const apiKey = page.getByRole('textbox', { name: 'API key', exact: true });
  await expect(apiKey).toBeFocused();
  await expect(apiKey).toHaveAttribute('aria-invalid', 'true');
  await expect(apiKey).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(apiKey).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(apiKey).toHaveAttribute('type', 'password');
  await expect(apiKey).not.toHaveAttribute('descriptionid');
  await expect(apiKey).not.toHaveAttribute('errorid');
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

  await page.getByRole('button', { name: 'History source' }).click();
  const questdbUrl = page.getByRole('textbox', { name: 'QuestDB REST URL', exact: true });
  await questdbUrl.fill('ftp://questdb.local');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await questdbUrl.fill('http://operator:secret@questdb.local:9000');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await questdbUrl.fill('http://questdb.local:9000?token=secret');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await saveButton.click();
  await expect(questdbUrl).toBeFocused();
  await expect(
    page.getByText('Enter an HTTP or HTTPS base URL without credentials, a query, or a fragment.'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Enter a valid history-provider HTTP or HTTPS base URL without credentials, a query, or a fragment before saving.',
    ),
  ).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-save-count', /\d/);
  await questdbUrl.fill('http://localhost:9000');

  await saveButton.click();
  await expect(page.locator('body')).toHaveAttribute('data-saved-configuration', /fixture-key/);
  const savedConfiguration = await page.locator('body').getAttribute('data-saved-configuration');
  expect(JSON.parse(savedConfiguration ?? '{}')).toMatchObject({
    extensionOwnedByAnotherPlugin: {
      enabled: true,
      nested: { retained: 'unchanged' },
    },
    openrouter: { futureOpenRouterSetting: { retained: 'openrouter' } },
    history: {
      source: 'questdb',
      futureHistorySetting: { retained: 'history' },
      questdb: {
        url: 'http://localhost:9000',
        futureQuestDBSetting: { retained: 'questdb' },
      },
      influxdb: { futureInfluxDBSetting: { retained: 'influxdb' } },
    },
    analyzers: {
      maintenance: {
        enabled: true,
        futureAnalyzerSetting: { retained: 'analyzer' },
      },
    },
  });
  expect(JSON.parse(savedConfiguration ?? '{}')).not.toHaveProperty('questdb');
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1');
  expect(await saveButton.evaluate((element) => element.hasAttribute('disabled'))).toBe(false);
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('aria-busy', 'true');
  await expect(saveButton).toHaveAccessibleName('Save configuration');
  await expect(saveButton).toHaveAccessibleDescription('Saving');
  const saveStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]');
  await expect(saveStatus).toBeFocused();
  await expect(saveStatus).toContainText('Save requested at');
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

test('configures and tests InfluxDB history without exposing credentials', async ({ page }) => {
  await page.getByRole('button', { name: 'Add API key' }).click();
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('fixture-key');
  await page.getByRole('button', { name: 'History source' }).click();

  const provider = page.getByRole('combobox', { name: 'History provider' });
  await provider.selectOption('influxdb');
  const influxUrl = page.getByRole('textbox', { name: 'InfluxDB URL', exact: true });
  const database = page.getByRole('textbox', { name: 'Database', exact: true });
  await influxUrl.fill('http://operator:secret@influx.local:8086');
  await expect(influxUrl).toHaveAttribute('aria-invalid', 'true');
  await influxUrl.fill('http://influx.local:8086');

  const saveButton = page
    .locator('[data-panel-action-bar]')
    .locator('button', { hasText: 'Save configuration' });
  await saveButton.click();
  await expect(database).toBeFocused();
  await expect(
    page.getByText('Enter the InfluxDB database or DBRP database name before saving.'),
  ).toBeVisible();

  await database.fill('signalk');
  await page.getByRole('combobox', { name: 'InfluxDB version' }).selectOption('2');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('operator');
  await page.getByLabel('Password or API token', { exact: true }).fill('fixture-token');
  await expect(page.getByLabel('Password or API token', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Reachable at http://influx.local:8086')).toBeVisible();

  await saveButton.click();
  const saved = JSON.parse(
    (await page.locator('body').getAttribute('data-saved-configuration')) ?? '{}',
  );
  expect(saved).toMatchObject({
    history: {
      source: 'influxdb',
      influxdb: {
        version: '2',
        url: 'http://influx.local:8086',
        database: 'signalk',
        username: 'operator',
        password: 'fixture-token',
        futureInfluxDBSetting: { retained: 'influxdb' },
      },
      futureHistorySetting: { retained: 'history' },
    },
    openrouter: { futureOpenRouterSetting: { retained: 'openrouter' } },
    analyzers: {
      maintenance: { futureAnalyzerSetting: { retained: 'analyzer' } },
    },
  });
  expect(saved).not.toHaveProperty('questdb');
});

test('gives repeated analyzer controls unique accessible names', async ({ page }) => {
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await clickClearOfActionBar(
    page.getByRole('button', { name: 'Maintenance Advisor', exact: true }),
  );

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

test('edits the scheduled fields and both drawers of an analyzer', async ({ page }) => {
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await clickClearOfActionBar(
    page.getByRole('button', { name: 'Weather Outlook Advisor', exact: true }),
  );

  const frequency = page.getByRole('combobox', { name: 'Frequency' });
  await expect(frequency).toHaveValue('0 */3 * * *');
  await frequency.selectOption('0 8 * * *');
  await expect(frequency).toHaveValue('0 8 * * *');

  const severityFloor = page.getByRole('combobox', { name: 'Severity floor' });
  await expect(severityFloor).toHaveValue('moderate');
  await severityFloor.selectOption('severe');
  await expect(severityFloor).toHaveValue('severe');

  const reportsToggle = page.getByRole('button', {
    name: 'View reports for Weather Outlook Advisor',
  });
  await reportsToggle.click();
  await expect(page.getByText('No reports yet')).toBeVisible();
  await page.getByRole('button', { name: 'Hide reports for Weather Outlook Advisor' }).click();
  await expect(reportsToggle).toBeFocused();

  await page.getByRole('button', { name: 'Edit prompt for Weather Outlook Advisor' }).click();
  const prompt = page.getByRole('textbox', { name: 'System prompt' });
  await expect(prompt).toHaveValue('Summarize the vessel data.');
  const reset = page.getByRole('button', { name: 'Reset to default' });
  await expect(reset).toHaveAttribute('aria-disabled', 'true');
  await prompt.fill('Fixture prompt override.');
  await expect(reset).not.toHaveAttribute('aria-disabled', 'true');
  await reset.click();
  await expect(prompt).toHaveValue('Summarize the vessel data.');
});

test('confirms before discarding unsaved edits', async ({ page }) => {
  await page.getByRole('button', { name: 'Add API key' }).click();
  const apiKey = page.getByRole('textbox', { name: 'API key', exact: true });
  await apiKey.fill('fixture-key');

  const discard = page.getByRole('button', { name: 'Discard', exact: true });
  await discard.click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(apiKey).toHaveValue('fixture-key');
  await expect(discard).toBeFocused();

  await discard.click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByText('Discard unsaved changes?')).toBeHidden();
  await expect(apiKey).toHaveValue('');
  await expect(page.getByText('No unsaved changes')).toBeVisible();
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

test('defaults a fresh profile to Auto without persisting an implicit choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    localStorage.removeItem('signalk-nearlcrews-ui.theme.v1');
    localStorage.removeItem('orc-theme');
    document.documentElement.removeAttribute('data-bs-theme');
    document.documentElement.removeAttribute('data-coreui-theme');
    document.documentElement.classList.remove('dark-mode');
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');

  const root = page.locator('[data-snui-root]');
  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });
  await expect(root).not.toHaveAttribute('data-snui-theme');
  await expect(root).toHaveCSS('background-color', 'rgb(244, 246, 248)');
  await expect(root).toHaveCSS('color', 'rgb(24, 32, 44)');
  await expect(themeGroup.getByRole('radio', { name: 'Auto' })).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('orc-theme'))).toBeNull();

  await themeGroup.getByRole('radio', { name: 'Dark' }).click();
  await expect(root).toHaveAttribute('data-snui-theme', 'dark');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBe('dark');
});

test('ignores the retired legacy preference and supports every theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    localStorage.removeItem('signalk-nearlcrews-ui.theme.v1');
    localStorage.setItem('orc-theme', 'night');
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.locator('[data-snui-root]')).not.toHaveAttribute('data-snui-theme');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('signalk-nearlcrews-ui.theme.v1')))
    .toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('orc-theme'))).toBe('night');

  const themeGroup = page.getByRole('radiogroup', { name: 'Panel theme' });
  for (const [label, value] of [
    ['Light', 'light'],
    ['Dark', 'dark'],
    ['Night', 'night'],
    ['System', 'system'],
  ] as const) {
    await themeGroup.getByRole('radio', { name: label }).click();
    await expect(page.locator('[data-snui-root]')).toHaveAttribute('data-snui-theme', value);
  }
  await expect(page.locator('[data-snui-root]')).toHaveCSS('background-color', 'rgb(16, 19, 28)');
  await themeGroup.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('[data-snui-root]')).not.toHaveAttribute('data-snui-theme');
  await expect(page.locator('[data-snui-root]')).toHaveCSS(
    'background-color',
    'rgb(244, 246, 248)',
  );
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
