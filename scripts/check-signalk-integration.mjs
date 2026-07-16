import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const baseUrl = new URL(process.env.SIGNALK_URL ?? 'http://127.0.0.1:3000');
const remotePath = `/${packageJson.name}/remoteEntry.js`;
const REQUEST_TIMEOUT_MS = 10_000;

const serverResponse = await fetch(new URL('/signalk', baseUrl), {
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
if (!serverResponse.ok) {
  throw new Error(`Signal K discovery failed with HTTP ${serverResponse.status}.`);
}

const adminResponse = await fetch(new URL('/admin/', baseUrl), {
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
if (!adminResponse.ok) {
  throw new Error(`Signal K Admin failed with HTTP ${adminResponse.status}.`);
}
const adminHtml = await adminResponse.text();
if (!adminHtml.includes(`src="${remotePath}"`)) {
  throw new Error(`Signal K Admin did not register ${remotePath}.`);
}

const remoteResponse = await fetch(new URL(remotePath, baseUrl), {
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
if (!remoteResponse.ok) {
  throw new Error(`The installed configuration remote failed with HTTP ${remoteResponse.status}.`);
}
const remoteSource = await remoteResponse.text();
if (!remoteSource.includes('export')) {
  throw new Error('The installed configuration remote is not an ESM container.');
}

console.log(`Signal K registered and served ${remotePath} from ${baseUrl.origin}.`);
