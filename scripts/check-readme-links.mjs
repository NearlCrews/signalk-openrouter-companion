import { readFile } from 'node:fs/promises';
import { relativeReadmeLinks } from './guards.mjs';

// The Signal K App Store renders README link targets unmodified, so a relative
// link is dead for every App Store reader. Relative image paths stay allowed:
// the App Store rewrites those against the published package.
const offending = relativeReadmeLinks(await readFile('README.md', 'utf8'));
if (offending.length > 0) {
  console.error(
    `README.md links must be absolute URLs or same-page anchors: ${offending
      .map((target) => `"${target}"`)
      .join(', ')}.`,
  );
  process.exit(1);
}

process.stdout.write('README links are absolute URLs or same-page anchors.\n');
