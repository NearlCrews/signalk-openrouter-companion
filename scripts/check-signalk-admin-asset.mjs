import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const baseUrl = new URL(process.env.SIGNALK_URL ?? 'http://127.0.0.1:3000');
const adminUrl = new URL('/admin/', baseUrl);
const remotePath = `/${packageJson.name}/remoteEntry.js`;

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  let remoteStatus;

  page.on('response', (response) => {
    if (new URL(response.url()).pathname === remotePath) remoteStatus = response.status();
  });

  await page.goto(adminUrl.href, { waitUntil: 'networkidle', timeout: 30_000 });

  if (remoteStatus !== 200) {
    throw new Error(
      `Signal K Admin did not request ${remotePath} successfully: ${remoteStatus ?? 'no request'}.`,
    );
  }
  if ((await page.locator('#root').count()) !== 1) {
    throw new Error('Signal K Admin did not mount its application root.');
  }

  console.log(`Signal K Admin requested ${remotePath} from ${baseUrl.origin}.`);
} finally {
  await browser?.close();
}
