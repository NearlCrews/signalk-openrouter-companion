import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelsSupersededRuns,
  devTreeAuditScripts,
  expandedCommands,
  playwrightInstallFailures,
  projectBrowsers,
  reachableScripts,
  relativeReadmeLinks,
  runsOnPushOrPullRequest,
  runsPlaywrightSuite,
  strictShares,
  workflowJobs,
} from './guards.mjs';

test('README links: absolute URLs, mail links, and anchors pass', () => {
  const readme = [
    '[Docs](https://example.com/docs) and [mail](mailto:a@example.com).',
    '[Jump](#configuration) <a href="https://example.com">site</a>',
    '[ref]: https://example.com/ref',
  ].join('\n');
  assert.deepEqual(relativeReadmeLinks(readme), []);
});

test('README links: relative inline, reference, and HTML link targets fail', () => {
  const readme = [
    'See [the guide](docs/DEVELOPMENT.md) and [changes](CHANGELOG.md#v080).',
    '[license]: LICENSE',
    "<a href='.github/SECURITY.md'>Security</a> <a href=docs/A.md>A</a>",
    '[empty]()',
  ].join('\n');
  assert.deepEqual(relativeReadmeLinks(readme), [
    'docs/DEVELOPMENT.md',
    'CHANGELOG.md#v080',
    '',
    'LICENSE',
    '.github/SECURITY.md',
    'docs/A.md',
  ]);
});

test('README links: relative images pass, including inside a badge link', () => {
  const readme = [
    '![Panel](assets/screenshots/panel-overview.png)',
    '[![Badge](assets/badge.svg)](https://example.com/build)',
    '<img src="assets/icons/icon-192.png" alt="">',
    '![Logo][logo]',
    '',
    '[logo]: assets/logo.png',
  ].join('\n');
  assert.deepEqual(relativeReadmeLinks(readme), []);
});

test('README links: a badge link with a relative target still fails', () => {
  assert.deepEqual(relativeReadmeLinks('[![Badge](https://img.example/b.svg)](LICENSE)'), [
    'LICENSE',
  ]);
});

test('README links: code spans and fenced blocks are not links', () => {
  const readme = ['Use `[x](docs/a.md)` here.', '```md', '[y](docs/b.md)', '```'].join('\n');
  assert.deepEqual(relativeReadmeLinks(readme), []);
});

test('strict shares: non-strict singletons without a fallback pass', () => {
  const shared = {
    react: { singleton: true, requiredVersion: '^19.2.0', import: false },
    'react-dom': { singleton: true, requiredVersion: '^19.2.0', import: false },
  };
  assert.deepEqual(strictShares(shared), []);
});

test('strict shares: an explicit strictVersion fails on any share', () => {
  assert.deepEqual(
    strictShares({
      react: { singleton: true, strictVersion: true, import: false },
      lodash: { strictVersion: false },
    }),
    ['react'],
  );
});

test('strict shares: a non-singleton share with a local fallback is strict by default', () => {
  assert.deepEqual(strictShares({ react: '^19.2.0', 'react-dom': { singleton: true } }), ['react']);
  assert.deepEqual(strictShares(['lodash', { react: { singleton: true } }]), ['lodash']);
});

test('script reach follows nested npm runs, flags, and pre and post scripts', () => {
  const scripts = {
    verify: 'npm run --silent lint && npm test',
    lint: 'biome ci .',
    pretest: 'node prepare-fixtures.mjs',
    test: 'vitest run',
  };
  assert.deepEqual([...reachableScripts('npx --yes npm@11.18.0 run verify', scripts)].sort(), [
    'lint',
    'pretest',
    'test',
    'verify',
  ]);
  assert.equal(expandedCommands('npm run lint', scripts).at(-1), 'biome ci .');
});

test('development-tree audits are npm audits without --omit=dev', () => {
  assert.deepEqual(
    [
      ...devTreeAuditScripts({
        'audit:runtime': 'npm audit --omit=dev --audit-level=high',
        'audit:release': 'npm audit --audit-level=high',
        lint: 'biome ci .',
      }),
    ],
    ['audit:release'],
  );
});

test('browser suite detection reads expanded commands', () => {
  assert.equal(runsPlaywrightSuite(['vitest run', 'playwright test --project=chromium']), true);
  assert.equal(runsPlaywrightSuite(['vitest run', 'npx playwright install chromium']), false);
});

const projects = [
  { name: 'chromium', use: { defaultBrowserType: 'chromium' } },
  { name: 'firefox', use: { defaultBrowserType: 'firefox' } },
  { name: 'webkit', use: { defaultBrowserType: 'webkit' } },
  { name: 'branded', use: { browserName: 'chromium', channel: 'chrome' } },
];
const scripts = {
  'test:browser': 'playwright test --project=chromium',
  'test:browser:cross': 'playwright test',
  'verify:release': 'npm run test:browser:cross',
};
const job = (steps) => `name: CI\n\njobs:\n  verify:\n    steps:\n${steps.join('\n')}\n`;

test('Playwright projects resolve to the browser each one installs', () => {
  assert.deepEqual(
    [...projectBrowsers(projects)],
    [
      ['chromium', 'chromium'],
      ['firefox', 'firefox'],
      ['webkit', 'webkit'],
      ['branded', 'chrome'],
    ],
  );
});

test('Playwright installs: a filtered suite needs only its own browser', () => {
  const source = job([
    '      - run: npx playwright install --with-deps chromium',
    '      - run: npm run test:browser',
  ]);
  assert.deepEqual(
    playwrightInstallFailures('ci.yml', source, scripts, projectBrowsers(projects)),
    [],
  );
});

test('Playwright installs: an unfiltered suite needs every project browser', () => {
  const source = job([
    '      - run: npx playwright install --with-deps chromium firefox webkit',
    '      - run: npx --yes npm@11.18.0 run verify:release',
  ]);
  assert.deepEqual(
    playwrightInstallFailures('ci.yml', source, scripts, projectBrowsers(projects)),
    ['ci.yml job verify runs Playwright on chrome without installing it.'],
  );
});

test('Playwright installs: a commented install and another job do not count', () => {
  const source = `${job([
    '      # - run: npx playwright install --with-deps chromium',
    '      - run: npm run test:browser',
  ])}  setup:\n    steps:\n      - run: npx playwright install chromium\n`;
  assert.deepEqual(
    playwrightInstallFailures('ci.yml', source, scripts, projectBrowsers(projects)),
    ['ci.yml job verify runs Playwright on chromium without installing it.'],
  );
});

test('Playwright installs: an unknown project filter fails', () => {
  const source = job([
    '      - run: npx playwright install',
    '      - run: npx playwright test --project=mobile-safari',
  ]);
  assert.deepEqual(
    playwrightInstallFailures('ci.yml', source, scripts, projectBrowsers(projects)),
    ['ci.yml job verify runs unknown Playwright project mobile-safari.'],
  );
});

test('workflow jobs split on two-space job keys under jobs only', () => {
  const source = 'on:\n  push:\njobs:\n  a:\n    steps: []\n  b-c:\n    runs-on: x\n';
  assert.deepEqual([...workflowJobs(source).keys()], ['a', 'b-c']);
});

test('concurrency must cancel superseded runs on the workflow and ref', () => {
  const block = (cancel) =>
    `on:\n  push:\n\nconcurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: ${cancel}\n`;
  assert.equal(cancelsSupersededRuns(block('true')), true);
  assert.equal(cancelsSupersededRuns(block('false')), false);
  assert.equal(cancelsSupersededRuns('on:\n  push:\n'), false);
});

test('push and pull request triggers are read from the on block only', () => {
  assert.equal(runsOnPushOrPullRequest('on:\n  pull_request:\n    branches: [main]\n'), true);
  assert.equal(
    runsOnPushOrPullRequest('on:\n  schedule:\n    - cron: x\n  workflow_dispatch:\n\njobs:\n'),
    false,
  );
  assert.equal(
    runsOnPushOrPullRequest('on:\n  workflow_dispatch:\njobs:\n  push:\n    steps: []\n'),
    false,
  );
});
