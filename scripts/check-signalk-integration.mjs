import { chromium } from '@playwright/test';
import { readPackageJson } from './repository.mjs';

// Checks the packed plugin inside a real, unsecured Signal K server: the server
// loads and enables it, serves the production configurator remote, and Signal
// K Admin mounts that remote in a browser. This is the check that catches a
// panel the host refuses to mount, such as a strict React share on 2.24 Admin.
const packageJson = readPackageJson();
// No default: port 3000 on a development host is usually a live server, and
// this check expects a disposable one with security off.
if (!process.env.SIGNALK_URL) {
  throw new Error('Set SIGNALK_URL to the disposable Signal K server under test.');
}
const baseUrl = new URL(process.env.SIGNALK_URL);
const remotePath = `/${packageJson.name}/remoteEntry.js`;
const expectedUiVersion = packageJson.devDependencies['signalk-nearlcrews-ui'];
const REQUEST_TIMEOUT_MS = 10_000;
const MOUNT_TIMEOUT_MS = 30_000;

async function fetchOk(path, description) {
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${description} failed with HTTP ${response.status}.`);
  }
  return response;
}

const plugins = await (await fetchOk('/skServer/plugins', 'Signal K plugin discovery')).json();
const installedPlugin = Array.isArray(plugins)
  ? plugins.find((plugin) => plugin.packageName === packageJson.name)
  : undefined;
if (!installedPlugin) {
  throw new Error(`Signal K did not load ${packageJson.name}.`);
}
if (installedPlugin.data?.enabled !== true) {
  throw new Error(`Signal K did not enable ${packageJson.name}.`);
}
for (const keyword of ['signalk-node-server-plugin', 'signalk-plugin-configurator']) {
  if (!installedPlugin.keywords?.includes(keyword)) {
    throw new Error(`Signal K did not recognize the ${keyword} keyword.`);
  }
}

const remoteSource = await (await fetchOk(remotePath, 'The installed configuration remote')).text();
if (!remoteSource.includes('export')) {
  throw new Error('The installed configuration remote is not an ESM container.');
}

const browser = await chromium.launch({ channel: process.env.SIGNALK_BROWSER_CHANNEL });
try {
  const page = await browser.newPage();
  let remoteStatus;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === remotePath) remoteStatus = response.status();
  });

  const pluginPage = new URL(
    `/admin/#/serverConfiguration/plugins/${encodeURIComponent(packageJson.name)}`,
    baseUrl,
  );
  await page.goto(pluginPage.href, { waitUntil: 'domcontentloaded', timeout: MOUNT_TIMEOUT_MS });
  // The panel's own React tree, rendered through the host's React share.
  await page
    .getByRole('heading', { name: 'Live status', exact: true })
    .waitFor({ state: 'visible', timeout: MOUNT_TIMEOUT_MS });

  if (remoteStatus !== 200) {
    throw new Error(`Signal K Admin did not load ${remotePath}: ${remoteStatus ?? 'no request'}.`);
  }
  const stampedVersion = await page
    .locator('[data-snui-root]')
    .first()
    .getAttribute('data-snui-version');
  if (stampedVersion !== expectedUiVersion) {
    throw new Error(
      `The mounted panel stamped signalk-nearlcrews-ui ${stampedVersion}, expected ${expectedUiVersion}.`,
    );
  }
  for (const fallback of ['Plugin Configuration Unavailable', 'Error loading component']) {
    if ((await page.getByText(fallback, { exact: true }).count()) > 0) {
      throw new Error(`Signal K Admin displayed "${fallback}".`);
    }
  }
} finally {
  await browser.close();
}

console.log(
  `Signal K at ${baseUrl.origin} enabled ${packageJson.name} and Admin mounted its production panel.`,
);
