import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import packageJson from '../../package.json' with { type: 'json' };

const EXPECTED_UI_VERSION = packageJson.devDependencies['signalk-nearlcrews-ui'];

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

// Measures every interactive control on screen: SIZE against the pointer floor
// and REACHABILITY at the target's center. Either alone gives a false reading.
// A control can measure the full floor and still be covered by the docked
// action bar, and a 20-pixel painted checkbox can be fine because its wrapping
// label carries the target. Exported as a helper so every panel state gets the
// same treatment.
async function measurePointerTargets(
  page: Page,
  // Limits the sweep to one subtree. Used for the discard confirmation, where
  // the rest of the page is legitimately covered by the grown action bar.
  rootSelector = 'body',
): Promise<{
  floor: number;
  measured: number;
  undersized: string[];
  blocked: string[];
}> {
  return page.evaluate(async (scope: string) => {
    const root = document.querySelector(scope);
    if (root === null) throw new Error(`No element matched ${scope}.`);
    const SELECTOR =
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="radio"], [role="switch"]';
    // WCAG 2.5.8 asks 24 pixels; the shared UI promises 40 on a fine pointer
    // and 44 on a coarse one, so assert the stronger contract we ship.
    const floor = window.matchMedia('(pointer: coarse)').matches ? 44 : 40;
    const undersized: string[] = [];
    const blocked: string[] = [];
    let measured = 0;

    for (const element of Array.from(root.querySelectorAll(SELECTOR))) {
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
      const name =
        element.getAttribute('aria-label') ??
        element.textContent?.trim().slice(0, 32) ??
        element.tagName.toLowerCase();
      const size = `${Math.round(target.width)}x${Math.round(target.height)}`;
      if (target.width < floor || target.height < floor) {
        undersized.push(`${name} (${size}, floor ${floor})`);
      }
      const hitTest = () => {
        const box = label?.getBoundingClientRect() ?? element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        const reached =
          hit !== null &&
          (hit === element ||
            element.contains(hit) ||
            hit.contains(element) ||
            (label !== null && (label === hit || label.contains(hit))));
        return { hit, reached };
      };
      let probe = hitTest();
      if (!probe.reached) {
        // The viewport-bottom action bar re-measures and re-docks in a
        // deferred frame, so a hit test in the same task as the scroll can
        // catch it still covering content it is about to release. Settle and
        // ask once more before calling anything blocked; a control that is
        // genuinely covered stays covered.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise((resolve) => setTimeout(resolve, 100));
        probe = hitTest();
      }
      if (!probe.reached) {
        const blocker = (probe.hit?.className || probe.hit?.tagName || 'nothing')
          .toString()
          .slice(0, 48);
        blocked.push(`${name} covered by ${blocker}`);
      }
    }
    return { floor, measured, undersized, blocked };
  }, rootSelector);
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

  const measurement = await measurePointerTargets(page);

  // A selector that stops matching would otherwise pass this test silently.
  expect(measurement.measured).toBeGreaterThan(25);
  expect(measurement.undersized, 'controls below the pointer target floor').toEqual([]);
  expect(measurement.blocked, 'controls covered by another element').toEqual([]);
});

// The discard confirmation renders inside the action bar, so it gets its own
// page rather than being stacked onto the sweep above: opening it grows the
// docked bar (105 to 356 pixels on a coarse viewport), which legitimately
// covers page content beneath it and would make a combined measurement report
// a layout consequence as if it were a defect.
test('gives the discard confirmation a reachable pointer target', async ({ page }) => {
  test.setTimeout(120_000);
  await page.getByRole('button', { name: 'Add API key' }).click();
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('fixture-key');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeVisible();

  // Scoped to the action bar: page controls behind the open confirmation are
  // covered by design, so sweeping the whole document here would report a
  // layout consequence as a defect. What must hold is that the confirmation's
  // own controls, and the bar's, are sized and reachable.
  const measurement = await measurePointerTargets(page, '[data-panel-action-bar]');

  expect(measurement.measured).toBeGreaterThan(3);
  expect(measurement.undersized, 'controls below the pointer target floor').toEqual([]);
  expect(measurement.blocked, 'controls covered by another element').toEqual([]);
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

  const measurement = await measurePointerTargets(page);

  expect(measurement.measured).toBeGreaterThan(10);
  expect(measurement.undersized, 'controls below the pointer target floor').toEqual([]);
  expect(measurement.blocked, 'controls covered by another element').toEqual([]);
});
