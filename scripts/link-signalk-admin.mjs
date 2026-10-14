import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// npm may hoist the Admin package out of signalk-server's own node_modules,
// while some server releases serve it only from that dependency-local path.
// Link the installed copy back to where the server looks for it.
const [hostArgument] = process.argv.slice(2);
if (!hostArgument) {
  throw new Error('Pass the Signal K test host directory.');
}
const hostDirectory = resolve(hostArgument);
const require = createRequire(import.meta.url);
const serverDirectory = dirname(
  require.resolve('signalk-server/package.json', { paths: [hostDirectory] }),
);
const expectedAdminDirectory = join(serverDirectory, 'node_modules', '@signalk', 'server-admin-ui');
let adminDirectory;

if (existsSync(expectedAdminDirectory)) {
  adminDirectory = realpathSync(expectedAdminDirectory);
} else {
  adminDirectory = dirname(
    require.resolve('@signalk/server-admin-ui/package.json', {
      paths: [serverDirectory, hostDirectory],
    }),
  );
  mkdirSync(dirname(expectedAdminDirectory), { recursive: true });
  symlinkSync(adminDirectory, expectedAdminDirectory, 'dir');
}

process.stdout.write(`Signal K Admin assets linked from ${adminDirectory}.\n`);
