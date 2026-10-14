import { readdir, readFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';
import {
  cancelsSupersededRuns,
  devTreeAuditScripts,
  expandedCommands,
  playwrightInstallFailures,
  projectBrowsers,
  reachableScripts,
  runsOnPushOrPullRequest,
  runsPlaywrightSuite,
  workflowJobs,
} from './guards.mjs';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const scripts = packageJson.scripts;
// The published floor, as a major: ">=22.18" reads as 22. The primary CI lane
// must run on that major or newer, which is the invariant. Which exact major
// it runs is a Node LTS decision, not a release invariant, so asserting one
// literal would turn every routine Node bump into a gate failure.
const engineFloorMajor = Number(/(\d+)/.exec(packageJson.engines.node)?.[1]);
if (!Number.isInteger(engineFloorMajor)) {
  console.error('package.json engines.node must start with a major version number.');
  process.exit(1);
}

const workflowDirectory = '.github/workflows';
const workflows = new Map();
for (const name of await readdir(workflowDirectory)) {
  if (name.endsWith('.yml') || name.endsWith('.yaml')) {
    workflows.set(name, await readFile(`${workflowDirectory}/${name}`, 'utf8'));
  }
}
const workflow = (name) => workflows.get(name) ?? '';
const failures = [];

for (const [name, source] of workflows) {
  const path = `${workflowDirectory}/${name}`;
  for (const [index, line] of source.split('\n').entries()) {
    const action = /\buses:\s+([^\s#]+)@([^\s#]+)/.exec(line);
    if (action !== null && !/^[0-9a-f]{40}$/.test(action[2] ?? '')) {
      failures.push(`${path}:${index + 1} must pin ${action[1]} to a full commit SHA.`);
    }
  }
  // Publishing must never be cancelled part way, so it keys its own group.
  if (name !== 'publish.yml' && !cancelsSupersededRuns(source)) {
    failures.push(`${path} must cancel superseded runs on the same workflow and ref.`);
  }
}

// What runs where. Push and pull request runs gate on the runtime audit the
// plugin registry scores; the development-tree audit runs weekly and at release.
const devAudits = devTreeAuditScripts(scripts);
for (const [name, source] of workflows) {
  if (!runsOnPushOrPullRequest(source)) continue;
  const reached = reachableScripts(source, scripts);
  const audits = [...devAudits].filter((script) => reached.has(script));
  if (audits.length > 0 || /\bnpm audit\b(?![^\n]*--omit[= ]dev)/.test(source)) {
    failures.push(`${name} must not run the development-tree audit on push or pull request.`);
  }
}
// One weekly workflow carries the checks that track the outside world, so
// each week adds a single run to the commit the plugin registry inspects.
const weekly = workflow('weekly.yml');
if (
  !/^ {2}schedule:/m.test(weekly) ||
  !/^ {2}workflow_dispatch:/m.test(weekly) ||
  runsOnPushOrPullRequest(weekly)
) {
  failures.push('weekly.yml must run on a schedule and on demand only.');
}
if (![...reachableScripts(weekly, scripts)].some((script) => devAudits.has(script))) {
  failures.push('weekly.yml must run the development-tree audit.');
}
if (!weekly.includes('run check:links:external')) {
  failures.push('weekly.yml must run check:links:external.');
}

// The local gate vocabulary the hooks, CI, and publishing rely on.
const reaches = (script, target) => reachableScripts(`npm run ${script}`, scripts).has(target);
const reachesDevAudit = (script) =>
  [...reachableScripts(`npm run ${script}`, scripts)].some((name) => devAudits.has(name));
const runsBrowsers = (script) =>
  runsPlaywrightSuite(expandedCommands(`npm run ${script}`, scripts));
if (runsBrowsers('verify') || reachesDevAudit('verify')) {
  failures.push('verify must run no browser suite and no development-tree audit.');
}
if (!reaches('verify:browser', 'verify') || !runsBrowsers('verify:browser')) {
  failures.push('verify:browser must run verify plus a browser suite.');
}
for (const script of ['verify:ci', 'verify:release']) {
  for (const target of ['verify', 'package:check', 'audit:runtime']) {
    if (!reaches(script, target)) failures.push(`${script} must run ${target}.`);
  }
  if (!runsBrowsers(script)) failures.push(`${script} must run a browser suite.`);
}
if (reachesDevAudit('verify:ci')) {
  failures.push('verify:ci must not run the development-tree audit.');
}
if (!reachesDevAudit('verify:release')) {
  failures.push('verify:release must run the development-tree audit.');
}
if (!/^npm run verify:release$/.test(scripts.prepublishOnly ?? '')) {
  failures.push('prepublishOnly must run verify:release.');
}
// Biome's CI mode already lints, so a second Biome lint in the commit gate is
// the same work twice.
const biomeRuns = expandedCommands('npm run verify:commit', scripts)
  .join('\n')
  .match(/\bbiome\s+(?:ci|check|lint)\b/g);
if (biomeRuns?.length !== 1) {
  failures.push(`verify:commit must run Biome once, not ${biomeRuns?.length ?? 0} times.`);
}
for (const [hook, script] of [
  ['pre-commit', 'verify:commit'],
  ['pre-push', 'verify'],
]) {
  const source = await readFile(`.githooks/${hook}`, 'utf8');
  if (!new RegExp(`^npm run (?:--silent )?${script}$`, 'm').test(source)) {
    failures.push(`.githooks/${hook} must run npm run ${script}.`);
  }
}

const ci = workflow('ci.yml');
const ciJobs = workflowJobs(ci);
const ciNodeMajors = [...ci.matchAll(/node-version:\s*'?(\d+)/g)].map((match) => Number(match[1]));
if (ciNodeMajors.length === 0) {
  failures.push('ci.yml must declare a node-version.');
} else if (ciNodeMajors.some((major) => major < engineFloorMajor)) {
  failures.push(
    `ci.yml runs Node ${ciNodeMajors.join(', ')}, below the engines.node floor of ${engineFloorMajor}.`,
  );
}
if (!(ciJobs.get('verify') ?? '').includes('run verify:ci')) {
  failures.push('ci.yml job verify must run verify:ci.');
}
// The Admin integration job runs on the documented server floor and the
// current release, so the README floor and the matrix cannot drift apart.
const readme = await readFile('README.md', 'utf8');
const serverFloor = /\[Signal K server\]\([^)]*\) (\d+\.\d+\.\d+) or newer/.exec(readme)?.[1];
const adminJob = ciJobs.get('signalk-admin') ?? '';
if (serverFloor === undefined) {
  failures.push('README.md must state the minimum Signal K server version.');
} else if (!adminJob.includes(`signalk_server: ['${serverFloor}', 'latest']`)) {
  failures.push(`ci.yml job signalk-admin must test Signal K ${serverFloor} and latest.`);
}
for (const expected of [
  'pack --ignore-scripts',
  'scripts/link-signalk-admin.mjs',
  'SIGNALK_BROWSER_CHANNEL: chrome',
  'run test:integration',
]) {
  if (!adminJob.includes(expected)) {
    failures.push(`ci.yml job signalk-admin must include ${expected}.`);
  }
}

const pluginCi = workflow('plugin-ci.yml');
if (!pluginCi.includes('SignalK/signalk-server/.github/workflows/plugin-ci.yml@')) {
  failures.push('plugin-ci.yml must retain the official Signal K reusable workflow.');
}
// The registry reads only the newest 20 runs on the published commit, so a
// weekly run keeps the reusable workflow in view while a release is main HEAD.
if (!/^ {2}schedule:/m.test(pluginCi)) {
  failures.push('plugin-ci.yml must also run on a weekly schedule.');
}
// ci.yml runs formatting, coverage, and the real-server Admin check once, and
// a tag points at a main commit whose push run covers it.
for (const [pattern, reason] of [
  [/^\s*tags:/m, 'a tag trigger'],
  [/\bformat-check-command:/, 'the format-check input'],
  [/\bcoverage-command:/, 'the coverage input'],
  [/\benable-signalk-integration:\s*true\b/, 'the reusable integration lane'],
]) {
  if (pattern.test(pluginCi)) failures.push(`plugin-ci.yml must not use ${reason}.`);
}

// Every workflow that runs a Playwright suite installs every browser the
// suite's projects launch, read from the Playwright configuration itself.
const playwrightModule = await tsImport('../playwright.config.ts', import.meta.url);
const playwrightConfig = playwrightModule.default?.default ?? playwrightModule.default;
const browsers = projectBrowsers(playwrightConfig.projects ?? []);
for (const [name, source] of workflows) {
  failures.push(
    ...playwrightInstallFailures(`${workflowDirectory}/${name}`, source, scripts, browsers),
  );
}

const codeql = workflow('codeql.yml');
for (const expected of ['github/codeql-action/init@', 'github/codeql-action/analyze@']) {
  if (!codeql.includes(expected)) failures.push(`codeql.yml must include ${expected}.`);
}

const publish = workflow('publish.yml');
for (const expected of [
  '--provenance --access public',
  'name: npm-package',
  'needs: build',
  'npm@11.18.0 pkg set gitHead="$GITHUB_SHA"',
  'PACKED_GIT_HEAD=',
  'run verify:release',
]) {
  if (!publish.includes(expected)) failures.push(`publish.yml must retain ${expected}.`);
}

const workflowSecurity = workflow('workflow-security.yml');
for (const expected of ['actionlint@v1.7.12', 'zizmor-action@']) {
  if (!workflowSecurity.includes(expected)) {
    failures.push(`workflow-security.yml must include ${expected}.`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

process.stdout.write(
  'Workflow pins, gate placement, browser installs, and release invariants passed.\n',
);
