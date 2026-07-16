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

const pluginsResponse = await fetch(new URL('/skServer/plugins', baseUrl), {
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
if (!pluginsResponse.ok) {
  throw new Error(`Signal K plugin discovery failed with HTTP ${pluginsResponse.status}.`);
}
const plugins = await pluginsResponse.json();
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
