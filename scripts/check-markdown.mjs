import { readdir, readFile, writeFile } from 'node:fs/promises';
import { applyFixes } from 'markdownlint';
import { lint, readConfig } from 'markdownlint/promise';

// Lints the maintained Markdown with the markdownlint library, called directly.
// Its command-line wrapper exists to expand globs, and that glob stack carried
// a high advisory with no fixed release (GHSA-vfj7-8cjw-p6xm in braces). The
// scope needs no glob: the guides at the root, in .github, and in docs, one
// level each, so the dated memos under docs/superpowers stay out. `--fix`
// applies markdownlint's own fixes in place, then reports what remains.
const DIRECTORIES = ['.', '.github', 'docs'];

const files = (
  await Promise.all(
    DIRECTORIES.map(async (directory) =>
      (
        await readdir(directory, { withFileTypes: true })
      )
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => (directory === '.' ? entry.name : `${directory}/${entry.name}`)),
    ),
  )
)
  .flat()
  .sort();

const config = await readConfig('.markdownlint.json');
let results = await lint({ config, files });

if (process.argv.includes('--fix')) {
  for (const path of files) {
    if (results[path].length === 0) continue;
    const source = await readFile(path, 'utf8');
    const fixed = applyFixes(source, results[path]);
    if (fixed !== source) await writeFile(path, fixed);
  }
  results = await lint({ config, files });
}

const failures = files.flatMap((path) =>
  results[path]
    .toSorted((left, right) => left.lineNumber - right.lineNumber)
    .map((issue) => {
      const detail = issue.errorDetail ?? issue.errorContext;
      return `${path}:${issue.lineNumber}: ${issue.ruleNames.join('/')} ${issue.ruleDescription}${detail ? ` [${detail}]` : ''}`;
    }),
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

process.stdout.write(`Markdown lint passed for ${files.length} files.\n`);
