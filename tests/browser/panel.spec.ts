import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import packageJson from '../../package.json' with { type: 'json' };

const EXPECTED_UI_VERSION = packageJson.devDependencies['signalk-nearlcrews-ui'];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await expect(page.getByRole('heading', { name: 'Live status' })).toBeVisible();
});

test('shows a standalone compatibility notice when native CSS scope is unavailable', async ({
  page,
}) => {
  await page.goto('/?unsupported-css-scope');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');

  const notice = page.getByRole('region', { name: 'Browser update required' });
  await expect(notice).toHaveAttribute('data-browser-compatibility-message', '');
  await expect(notice).toContainText('This panel needs a newer browser');
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
  // A pristine required field is not accused of an error: the mark and its
  // message appear only once a save is actually blocked on it.
  await expect(apiKey).not.toHaveAttribute('aria-invalid');
  await expect(page.getByText('Enter an OpenRouter API key.')).toBeHidden();
  await expect(apiKey).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(apiKey).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(apiKey).toHaveAttribute('type', 'password');
  await expect(apiKey).not.toHaveAttribute('descriptionid');
  await expect(apiKey).not.toHaveAttribute('errorid');
  await apiKey.fill('   ');

  const saveButton = page
    .locator('[data-panel-action-bar]')
    .locator('button', { hasText: 'Save configuration' });
  await saveButton.click();
  await expect(apiKey).toBeFocused();
  await expect(apiKey).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter an OpenRouter API key.')).toBeVisible();
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
  await expect(questdbUrl).not.toHaveAttribute('aria-invalid');
  await saveButton.click();
  await expect(questdbUrl).toBeFocused();
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await questdbUrl.fill('http://operator:secret@questdb.local:9000');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
  await questdbUrl.fill('http://questdb.local:9000?token=secret');
  await expect(questdbUrl).toHaveAttribute('aria-invalid', 'true');
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
  await expect(saveButton).toHaveAccessibleDescription('Saving changes');
  const saveStatus = page.locator('[data-panel-action-bar] [tabindex="-1"]');
  await expect(saveStatus).toBeFocused();
  await expect(saveStatus).toContainText('Saving changes');

  await saveButton.dispatchEvent('click');
  await expect(page.locator('body')).toHaveAttribute('data-save-count', '1');

  await page.evaluate(() => document.dispatchEvent(new Event('fixture-host-resync')));
  await expect(page.locator('body')).toHaveAttribute('data-host-resync-count', '1');
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).not.toHaveAttribute('aria-busy');
  await expect(page.getByText(/Plugin restarted\./)).toBeVisible();
  await expect(saveStatus).toBeFocused();
  await expect(saveStatus).toContainText('Saved at');
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
  const saveButton = page
    .locator('[data-panel-action-bar]')
    .locator('button', { hasText: 'Save configuration' });
  await influxUrl.fill('http://operator:secret@influx.local:8086');
  await expect(influxUrl).not.toHaveAttribute('aria-invalid');
  await saveButton.click();
  await expect(influxUrl).toBeFocused();
  await expect(influxUrl).toHaveAttribute('aria-invalid', 'true');
  await influxUrl.fill('http://influx.local:8086');

  await saveButton.click();
  await expect(database).toBeFocused();
  await expect(database).toHaveAttribute('aria-invalid', 'true');
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
  await expect(
    page.getByText('Reachable at http://influx.local:8086', { exact: true }),
  ).toBeVisible();

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
  await page.getByRole('button', { name: 'Maintenance Advisor', exact: true }).click();

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
  await page.getByRole('button', { name: 'Weather Outlook Advisor', exact: true }).click();

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
  await expect(page.getByText('No reports yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide reports for Weather Outlook Advisor' }).click();
  await expect(reportsToggle).toBeFocused();

  await page.getByRole('button', { name: 'Edit prompt for Weather Outlook Advisor' }).click();
  const prompt = page.getByRole('textbox', { name: 'System prompt' });
  await expect(prompt).toHaveValue('Summarize the vessel data.');
  const reset = page.getByRole('button', { name: 'Reset to default' });
  await expect(reset).toHaveAttribute('aria-disabled', 'true');
  // An inert control explains itself in text, not in a `title` that only a
  // pointer hover reveals.
  await expect(reset).toHaveAccessibleDescription(
    'This analyzer is already using the built-in default, so there is nothing to reset.',
  );
  await prompt.fill('Fixture prompt override.');
  await expect(reset).not.toHaveAttribute('aria-disabled', 'true');
  await reset.click();
  await expect(prompt).toHaveValue('Summarize the vessel data.');

  // The in-panel Close closes through the disclosure, so focus returns to the
  // toggle. Closing by flipping the consumer's own open state moves no focus,
  // and this panel unmounts its children, which would drop focus to the body.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(
    page.getByRole('button', { name: 'Edit prompt for Weather Outlook Advisor' }),
  ).toBeFocused();
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
  // The save bar moves focus to its status before Discard runs, so the
  // confirmation hands focus back there when it closes.
  await expect(page.locator('[data-panel-action-bar] [tabindex="-1"]')).toBeFocused();

  await discard.click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByText('Discard unsaved changes?')).toBeHidden();
  await expect(apiKey).toHaveValue('');
  await expect(page.getByText('All changes saved')).toBeVisible();
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

test('defaults a fresh profile to Match Admin without persisting an implicit choice', async ({
  page,
}) => {
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
  await expect(themeGroup.getByRole('radio', { name: 'Match Admin' })).toBeChecked();
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
    ['Match device', 'system'],
  ] as const) {
    await themeGroup.getByRole('radio', { name: label }).click();
    await expect(page.locator('[data-snui-root]')).toHaveAttribute('data-snui-theme', value);
  }
  await expect(page.locator('[data-snui-root]')).toHaveCSS('background-color', 'rgb(16, 19, 28)');
  await themeGroup.getByRole('radio', { name: 'Match Admin' }).click();
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

// Measures every interactive control on screen: SIZE against the pointer floor
// and REACHABILITY at the target's center. Either alone gives a false reading.
// A control can measure the full floor and still be covered by the docked
// action bar, and a 20-pixel painted checkbox can be fine because its wrapping
// label carries the target. Exported as a helper so every panel state gets the
// same treatment.
function measurePointerTargets(page: Page): Promise<{
  floor: number;
  measured: number;
  undersized: string[];
  blocked: string[];
}> {
  return page.evaluate(() => {
    const root = document.body;
    const SELECTOR =
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="radio"], [role="switch"]';
    // WCAG 2.5.8 asks 24 pixels; the shared UI promises 40 on a fine pointer
    // and 44 on a coarse one, so assert the stronger contract we ship.
    const floor = window.matchMedia('(pointer: coarse)').matches ? 44 : 40;
    const undersized: string[] = [];
    const blocked: string[] = [];
    let measured = 0;

    // Only the two failure branches need a control's name, and building one
    // walks its text subtree, so it stays off the happy path.
    const describe = (element: Element): string =>
      element.getAttribute('aria-label') ??
      element.textContent?.trim().slice(0, 32) ??
      element.tagName.toLowerCase();

    for (const element of root.querySelectorAll(SELECTOR)) {
      if (!(element instanceof HTMLElement)) continue;
      // A user scrolls a control into view before pressing it, so measure it
      // the same way rather than judging whatever happens to be on screen.
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      measured += 1;

      const label = element.closest('label');
      const target = label?.getBoundingClientRect() ?? rect;
      if (target.width < floor || target.height < floor) {
        const size = `${Math.round(target.width)}x${Math.round(target.height)}`;
        undersized.push(`${describe(element)} (${size}, floor ${floor})`);
      }
      const hit = document.elementFromPoint(
        target.x + target.width / 2,
        target.y + target.height / 2,
      );
      const reached =
        hit !== null &&
        (hit === element ||
          element.contains(hit) ||
          hit.contains(element) ||
          (label !== null && (label === hit || label.contains(hit))));
      if (!reached) {
        const blocker = (hit?.className || hit?.tagName || 'nothing').toString().slice(0, 48);
        blocked.push(`${describe(element)} covered by ${blocker}`);
      }
    }
    return { floor, measured, undersized, blocked };
  });
}

// Every sweep asserts the same three things and varies only how many controls
// its panel state should render, so the trio lives here rather than in three
// near-identical copies. The count guard is load-bearing: a selector that
// stopped matching would otherwise let an empty sweep pass silently.
function expectReachableTargets(
  measurement: Awaited<ReturnType<typeof measurePointerTargets>>,
  atLeast: number,
): void {
  expect(measurement.measured).toBeGreaterThan(atLeast);
  expect(measurement.undersized, 'controls below the pointer target floor').toEqual([]);
  expect(measurement.blocked, 'controls covered by another element').toEqual([]);
}

test('gives every interactive control a reachable pointer target', async ({ page }) => {
  test.setTimeout(120_000);
  // Controls that only exist while a section or drawer is open count too.
  await page.getByRole('button', { name: 'OpenRouter' }).click();
  await page.getByRole('button', { name: 'History source' }).click();
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await page.getByRole('button', { name: 'Weather Outlook Advisor', exact: true }).click();
  await page.getByRole('button', { name: /View reports for Weather/ }).click();
  await page.getByRole('button', { name: /Edit prompt for Weather/ }).click();
  // The InfluxDB branch renders five more fields than the QuestDB default.
  await page.getByRole('combobox', { name: 'History provider' }).selectOption('influxdb');
  await expect(page.getByRole('textbox', { name: 'InfluxDB URL', exact: true })).toBeVisible();

  expectReachableTargets(await measurePointerTargets(page), 25);
});

// The discard confirmation renders in flow above the docked save bar, and its
// controls exist only while it is open, so it gets its own sweep.
test('gives the discard confirmation a reachable pointer target', async ({ page }) => {
  test.setTimeout(120_000);
  await page.getByRole('button', { name: 'Add API key' }).click();
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('fixture-key');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeVisible();

  expectReachableTargets(await measurePointerTargets(page), 3);
});

test('gives failure-state controls a reachable pointer target', async ({ page }) => {
  test.setTimeout(120_000);
  // The retry banner and the prompt drawer's error branch each own a control
  // the happy path never renders, which is exactly where an undersized target
  // hides from every other gate.
  await page.goto('/?models-error&prompt-error');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');

  await page.getByRole('button', { name: 'OpenRouter' }).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await page.getByRole('button', { name: 'Analyzers' }).click();
  await page.getByRole('button', { name: 'Maintenance Advisor', exact: true }).click();
  await page.getByRole('button', { name: /Edit prompt for Maintenance/ }).click();
  await expect(page.getByText(/Failed to load prompt/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

  expectReachableTargets(await measurePointerTargets(page), 10);

  // The error branch owns a second Close button, wired the same way.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(
    page.getByRole('button', { name: 'Edit prompt for Maintenance Advisor' }),
  ).toBeFocused();
});

test('announces a fire outcome from a region that already existed', async ({ page }) => {
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await page.getByRole('button', { name: 'Maintenance Advisor', exact: true }).click();

  // The region is in the document, and empty, before the run: a live region
  // created in the same commit as its message is not announced reliably. Every
  // row keeps one, so it is read through the row that owns it.
  const row = page.getByRole('region', { name: 'Maintenance Advisor', exact: true });
  const announcer = row.locator('[data-fire-announcement]');
  await expect(announcer).toHaveText('');
  await expect(announcer).toHaveAttribute('role', 'status');
  await announcer.evaluate((element) => element.setAttribute('data-marked', ''));

  const fire = page.getByRole('button', { name: 'Fire now for Maintenance Advisor' });
  // The cost of pressing it is stated beside the button, not in a section the
  // operator may never open.
  await expect(fire).toHaveAccessibleDescription(
    'Running an analyzer now makes one paid OpenRouter call that counts against the daily cap.',
  );
  await fire.click();

  // The same node carries the text, rather than a fresh node appearing with it.
  const marked = row.locator('[data-fire-announcement][data-marked]');
  await expect(marked).toHaveText(/^Maintenance Advisor: Report generated at .+\.$/);
  const first = await marked.textContent();

  // A second identical outcome still announces, because the completion time
  // gives the region a content change to speak.
  await page.waitForTimeout(1100);
  await fire.click();
  await expect.poll(() => marked.textContent()).not.toBe(first);
  await expect(marked).toHaveText(/^Maintenance Advisor: Report generated at .+\.$/);
});

test('renders a populated report list without Axe findings or overflow', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?reports');
  await expect(page.locator('body')).toHaveAttribute('data-fixture-ready', 'true');
  await page.getByRole('button', { name: 'Analyzers' }).click();
  await page.getByRole('button', { name: 'Battery Health Advisor', exact: true }).click();
  await page.getByRole('button', { name: /View reports for Battery Health/ }).click();

  const reports = page.getByRole('region', { name: 'Reports for Battery Health Advisor' });
  await expect(reports.getByText('No reports yet')).toBeHidden();
  // The timestamp reads as words and still carries a machine-readable value,
  // and the trigger reads as interface copy rather than a log field.
  await expect(reports.getByText('2 hours ago')).toBeVisible();
  await expect(reports.locator('time').first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(reports.getByText('Scheduled')).toBeVisible();
  await expect(reports.getByText('Engine stop')).toBeVisible();
  await expect(reports.getByText('Manual run')).toBeVisible();
  await expect(reports.getByText('1,842 tokens')).toBeVisible();
  await expect(reports.getByText('$0.0123')).toBeVisible();
  await expect(
    reports.getByText('Failure: OpenRouter returned 502 after three attempts.'),
  ).toBeVisible();
  await expect(reports.getByText('House bank held 12.9 V overnight.')).toBeVisible();

  expectReachableTargets(await measurePointerTargets(page), 15);

  await page.setViewportSize({ width: 320, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
