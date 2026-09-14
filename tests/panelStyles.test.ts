import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const panelDirectory = fileURLToPath(new URL('../src/configpanel', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function cssModules(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...cssModules(fullPath));
    else if (entry.name.endsWith('.module.css')) output.push(fullPath);
  }
  return output;
}

// Class selectors, read off a stylesheet with its comments removed so prose
// about a class is not mistaken for a rule.
function classNames(source: string): Set<string> {
  const rules = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...rules.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? ''));
}

describe('panel styling boundary', () => {
  it('keeps plugin styles in CSS modules the discovery can read', () => {
    expect(cssModules(panelDirectory).length).toBeGreaterThanOrEqual(1);
  });

  it('declares every plugin class in its doubled form', () => {
    // The shared UI ships every rule inside a native CSS scope. The cascade
    // compares scope proximity after specificity and before source order, and
    // an unscoped rule counts as infinitely distant, so a single-class plugin
    // rule loses to the package rule it means to override however the
    // stylesheets are ordered. Repeating the class name wins on specificity,
    // which is settled first. The prompt editor shipped at the library's
    // six-line default for exactly this reason before `minRows` replaced the
    // override, so the convention is worth pinning.
    //
    // The rule is read off the stylesheets rather than off the JSX that uses
    // them: doubling costs nothing on a class that lands on a native element,
    // and an invariant a regex can check on a stylesheet cannot quietly stop
    // covering a class because the markup around it was reformatted.
    for (const file of cssModules(panelDirectory)) {
      const source = readFileSync(file, 'utf8');
      for (const name of classNames(source)) {
        const undoubled = source.replaceAll(`.${name}.${name}`, '');
        expect(
          undoubled,
          `${relative(repositoryRoot, file)}: .${name} must be declared as .${name}.${name}`,
        ).not.toMatch(new RegExp(`\\.${name}(?![\\w-])`));
      }
    }
  });
});
