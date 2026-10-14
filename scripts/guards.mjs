// Pure policy checks behind the repository guard scripts. Each one takes text
// or parsed configuration and returns what it found, so `guards.test.mjs` pins
// the policy without a fixture repository and the guard scripts stay thin.

// Link targets the Signal K App Store can follow from the README it renders.
const SAFE_LINK_TARGET = /^(?:https?:|mailto:|#)/i;

// What a bare `playwright install` downloads.
const DEFAULT_PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'];

// Fenced blocks and inline code spans are literal text, never links.
function stripCode(markdown) {
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * README link targets the Signal K App Store would leave dead. The App Store
 * renders link targets unmodified and rewrites only image sources against the
 * package, so every Markdown link, reference definition, and HTML anchor must
 * be an http, https, or mailto URL or a same-page anchor. Images are exempt.
 * @param {string} markdown
 * @returns {string[]} the offending targets, in document order per syntax
 */
export function relativeReadmeLinks(markdown) {
  const text = stripCode(markdown);
  // A definition that only an image reference uses renders as an image.
  const imageLabels = new Set(
    [...text.matchAll(/!\[([^\]]*)\](?!\()(?:\[([^\]]*)\])?/g)].map((match) =>
      (match[2] || match[1]).toLowerCase(),
    ),
  );
  // Flatten inline images first, so the image inside a badge link
  // ([![alt](src)](href)) is not read as the link itself.
  const withoutImages = text.replace(/!\[[^\]]*\]\([^)]*\)/g, 'image');
  const inlineLinks = [...withoutImages.matchAll(/\[[^\]]*\]\(\s*<?([^\s)>]*)/g)].map(
    (match) => match[1],
  );
  const definitions = [...text.matchAll(/^ {0,3}\[(?!\^)([^\]]+)\]:\s*<?([^\s>]*)/gm)]
    .filter((match) => !imageLabels.has(match[1].toLowerCase()))
    .map((match) => match[2]);
  const anchors = [
    ...text.matchAll(/<a\s[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  return [...inlineLinks, ...definitions, ...anchors].filter(
    (target) => !SAFE_LINK_TARGET.test(target),
  );
}

/**
 * Module Federation shares that would refuse a host whose registered version
 * misses `requiredVersion`. Signal K 2.24 Admin registers its React share as
 * 19.0.0 whatever React it ships, so a strict share never mounts there.
 * webpack also makes a share strict by default when it has a local fallback
 * and is not a singleton, so that implicit case counts too.
 * @param {unknown} shared the ModuleFederationPlugin `shared` option
 * @returns {string[]} the strict share names
 */
export function strictShares(shared) {
  const entries = Array.isArray(shared)
    ? shared.flatMap((item) =>
        typeof item === 'string' ? [[item, {}]] : Object.entries(item ?? {}),
      )
    : Object.entries(shared ?? {});
  return entries
    .filter(([, hint]) => {
      const options = typeof hint === 'object' && hint !== null ? hint : {};
      if (options.strictVersion !== undefined) return options.strictVersion === true;
      return options.import !== false && options.singleton !== true;
    })
    .map(([name]) => name);
}

/**
 * The browser each Playwright project launches, named the way
 * `playwright install` takes it: the channel when one is set, otherwise the
 * engine the project's device descriptor or `browserName` selects.
 * @param {Array<{ name: string, use?: Record<string, unknown> }>} projects
 * @returns {Map<string, string>} project name to browser
 */
export function projectBrowsers(projects) {
  return new Map(
    projects.map((project) => [
      project.name,
      String(
        project.use?.channel ??
          project.use?.browserName ??
          project.use?.defaultBrowserType ??
          'chromium',
      ),
    ]),
  );
}

/**
 * Every npm script a command text starts, followed through nested `npm run`
 * calls and the pre and post scripts npm runs around each one.
 * @param {string} text
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
export function reachableScripts(text, scripts) {
  const reached = new Set();
  const visit = (commandText) => {
    const calls = [
      ...[
        ...commandText.matchAll(
          /\bnpm(?:@[\w.-]+)?\s+run(?:-script)?\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w:.-]+)/g,
        ),
      ].map((match) => match[1]),
      ...[...commandText.matchAll(/\bnpm(?:@[\w.-]+)?\s+t(?:est)?\b/g)].map(() => 'test'),
    ];
    for (const name of calls) {
      for (const script of [`pre${name}`, name, `post${name}`]) {
        if (reached.has(script) || scripts[script] === undefined) continue;
        reached.add(script);
        visit(scripts[script]);
      }
    }
  };
  visit(text);
  return reached;
}

/**
 * The command text a workflow job or script runs, with every script it
 * reaches expanded, so callers can look for a tool however deep it sits.
 * @param {string} text
 * @param {Record<string, string>} scripts
 * @returns {string[]}
 */
export function expandedCommands(text, scripts) {
  return [text, ...[...reachableScripts(text, scripts)].map((name) => scripts[name])];
}

/**
 * Names of npm scripts that audit the development tree: an `npm audit`
 * without `--omit=dev`.
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
export function devTreeAuditScripts(scripts) {
  return new Set(
    Object.entries(scripts)
      .filter(([, body]) => /\bnpm audit\b/.test(body) && !/--omit[= ]dev\b/.test(body))
      .map(([name]) => name),
  );
}

/**
 * Whether any of these commands runs a Playwright test suite.
 * @param {string[]} commands
 */
export function runsPlaywrightSuite(commands) {
  return commands.some((command) => /\bplaywright\s+test\b/.test(command));
}

/**
 * Split a workflow into the text of each job, keyed by job id. Comment lines
 * are dropped so a commented-out step never counts.
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function workflowJobs(source) {
  const jobs = new Map();
  let inJobs = false;
  let current;
  for (const line of source.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = undefined;
      continue;
    }
    if (!inJobs) continue;
    const header = /^ {2}([\w-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
    } else if (current !== undefined) {
      jobs.get(current).push(line);
    }
  }
  return new Map([...jobs].map(([id, lines]) => [id, lines.join('\n')]));
}

/**
 * Browsers a job's `playwright install` steps provide.
 * @param {string} jobText
 * @returns {Set<string>}
 */
function installedBrowsers(jobText) {
  const installed = new Set();
  for (const match of jobText.matchAll(/\bplaywright\s+install(?![\w-])([^\n]*)/g)) {
    const names = match[1]
      .trim()
      .split(/\s+/)
      .filter((token) => token && !token.startsWith('-'));
    for (const name of names.length > 0 ? names : DEFAULT_PLAYWRIGHT_BROWSERS) {
      installed.add(name);
    }
  }
  return installed;
}

/**
 * Jobs that run a Playwright suite without installing every browser the
 * suite's projects launch. A `playwright test` call without `--project` runs
 * every project in the configuration, so adding a project on a new engine
 * fails here until each workflow installs it.
 * @param {string} path
 * @param {string} source
 * @param {Record<string, string>} scripts
 * @param {Map<string, string>} browsers from `projectBrowsers`
 * @returns {string[]}
 */
export function playwrightInstallFailures(path, source, scripts, browsers) {
  const failures = [];
  for (const [job, text] of workflowJobs(source)) {
    const needed = new Set();
    for (const command of expandedCommands(text, scripts)) {
      for (const call of command.matchAll(/\bplaywright\s+test\b([^&|;\n]*)/g)) {
        const filters = [...call[1].matchAll(/--project(?:=|\s+)(\S+)/g)].map((m) => m[1]);
        for (const project of filters.length > 0 ? filters : browsers.keys()) {
          const browser = browsers.get(project);
          if (browser === undefined) {
            failures.push(`${path} job ${job} runs unknown Playwright project ${project}.`);
          } else {
            needed.add(browser);
          }
        }
      }
    }
    const installed = installedBrowsers(text);
    const missing = [...needed].filter((browser) => !installed.has(browser));
    if (missing.length > 0) {
      failures.push(
        `${path} job ${job} runs Playwright on ${missing.join(', ')} without installing it.`,
      );
    }
  }
  return failures;
}

/**
 * Whether a workflow cancels its superseded runs on the same ref.
 * @param {string} source
 */
export function cancelsSupersededRuns(source) {
  return /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true$/m.test(
    source,
  );
}

/**
 * Whether a workflow runs on push or pull request events.
 * @param {string} source
 */
export function runsOnPushOrPullRequest(source) {
  const triggers = /^on:\s*\n((?: {2}.*\n|\s*\n)*)/m.exec(source)?.[1] ?? '';
  return /^ {2}(?:push|pull_request):/m.test(triggers);
}
