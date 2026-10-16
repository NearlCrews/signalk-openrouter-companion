import { readFileSync } from 'node:fs';

// The repository root, whichever directory a script was started from.
export const repositoryDir = new URL('../', import.meta.url);

// The package manifest, read from the repository root.
export function readPackageJson() {
  return JSON.parse(readFileSync(new URL('package.json', repositoryDir), 'utf8'));
}

// End a check: print every failure, one per line, and exit nonzero when there
// is any.
export function exitOnFailures(failures) {
  if (failures.length === 0) return;
  console.error(failures.join('\n'));
  process.exit(1);
}
