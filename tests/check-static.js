/**
 * Static wiring checks.
 *
 * The unit suite covers pure logic, and the end-to-end suite covers behaviour in
 * a real browser. In between there is a class of mistake that is cheap to make
 * and expensive to find by hand: a control renamed in the markup but not in the
 * script, an import that points at a file that moved, or a named export that no
 * longer exists. These checks read the sources as text and catch exactly that,
 * with no dependencies and no browser.
 *
 * Run with: node tests/check-static.js
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/**
 * The published site. Separate from ROOT because this file checks two different
 * things: the markup and scripts that ship (under `public/`), and the test sources
 * that do not. Paths in failure messages stay relative to ROOT so they read the way
 * you would type them.
 */
const SITE = join(ROOT, 'public');
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

/** Every .js file under a directory, recursively. */
function collectScripts(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.js')) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/** Strip comments and string literals so pattern matching sees only code. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const appScripts = collectScripts(join(SITE, 'js'));
const html = readFileSync(join(SITE, 'index.html'), 'utf8');

/* ------------------------------------------------------------ markup ids */

const htmlIds = [];
for (const match of html.matchAll(/\sid="([^"]+)"/g)) htmlIds.push(match[1]);
const htmlIdSet = new Set(htmlIds);

const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
if (duplicateIds.length) {
  fail(`index.html has duplicate ids: ${[...new Set(duplicateIds)].join(', ')}`);
}

// Every id referenced from script must exist in the markup, otherwise the
// control is silently dead.
for (const file of appScripts) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
    if (!htmlIdSet.has(match[1])) {
      fail(`${relative(ROOT, file)} looks up #${match[1]}, which is not in index.html`);
    }
  }
}

// Labels, aria references and popover targets must all resolve.
const referenceAttributes = [
  ['for', /\sfor="([^"]+)"/g],
  ['aria-labelledby', /\saria-labelledby="([^"]+)"/g],
  ['aria-describedby', /\saria-describedby="([^"]+)"/g],
  ['aria-controls', /\saria-controls="([^"]+)"/g],
  ['popovertarget', /\spopovertarget="([^"]+)"/g]
];
for (const [attribute, pattern] of referenceAttributes) {
  for (const match of html.matchAll(pattern)) {
    for (const id of match[1].trim().split(/\s+/)) {
      if (!htmlIdSet.has(id)) {
        fail(`index.html ${attribute}="${id}" does not match any element id`);
      }
    }
  }
}

/* --------------------------------------------------------- asset references */

for (const match of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (/^(https?:|data:|mailto:|#)/.test(reference)) continue;
  if (!existsSync(join(SITE, reference))) {
    fail(`index.html references a missing asset: ${reference}`);
  }
}

for (const match of html.matchAll(/data-sample-path="([^"]+)"/g)) {
  if (!existsSync(join(SITE, match[1]))) {
    fail(`index.html lists a missing sample score: ${match[1]}`);
  }
}

/* ------------------------------------------------------ module graph checks */

const exportCache = new Map();

/** Named and default exports declared by a module. */
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const source = readFileSync(file, 'utf8');
  const names = new Set();

  const patterns = [
    /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  // export { a, b as c }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const alias = part.split(/\sas\s/).pop().trim();
      if (alias) names.add(alias);
    }
  }
  if (/export\s+default\b/.test(source)) names.add('default');

  exportCache.set(file, names);
  return names;
}

for (const file of appScripts.concat(collectScripts(join(ROOT, 'tests')))) {
  const source = readFileSync(file, 'utf8');
  const importPattern = /import\s+([\s\S]*?)\s+from\s+'([^']+)'|import\s+'([^']+)'/g;

  for (const match of source.matchAll(importPattern)) {
    const clause = match[1] || '';
    const specifier = match[2] || match[3];
    if (!specifier.startsWith('.')) continue;

    const target = resolve(dirname(file), specifier);
    if (!existsSync(target)) {
      fail(`${relative(ROOT, file)} imports '${specifier}', which does not exist`);
      continue;
    }

    const available = exportsOf(target);
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (const entry of braces[1].split(',')) {
      const name = entry.split(/\sas\s/)[0].trim();
      if (!name || name.startsWith('//')) continue;
      if (!available.has(name)) {
        fail(`${relative(ROOT, file)} imports { ${name} } from '${specifier}', which does not export it`);
      }
    }
  }
}

/* -------------------------------------------------------------- code hygiene */

for (const file of appScripts) {
  const code = stripNonCode(readFileSync(file, 'utf8'));
  const relativePath = relative(ROOT, file);

  for (const match of code.matchAll(/console\.log\(/g)) {
    const line = code.slice(0, match.index).split('\n').length;
    fail(`${relativePath}:${line} left a console.log in shipped code`);
  }

  // A method called with more arguments than it declares is usually a leftover
  // from a refactor, and always misleading to read.
  const declarations = new Map();
  for (const match of code.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor'].includes(name)) continue;
    const parameters = match[2].trim();
    declarations.set(name, parameters ? parameters.split(',').length : 0);
  }
  for (const [name, arity] of declarations) {
    const callPattern = new RegExp(`this\\.${name}\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');
    for (const call of code.matchAll(callPattern)) {
      const argumentText = call[1].trim();
      if (!argumentText) continue;
      // Count only top-level commas.
      let depth = 0;
      let count = 1;
      for (const character of argumentText) {
        if ('([{'.includes(character)) depth++;
        else if (')]}'.includes(character)) depth--;
        else if (character === ',' && depth === 0) count++;
      }
      if (count > arity) {
        const line = code.slice(0, call.index).split('\n').length;
        fail(
          `${relativePath}:${line} calls this.${name}() with ${count} arguments but it declares ${arity}`
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

notes.push(`checked ${appScripts.length} modules, ${htmlIdSet.size} element ids`);

console.log('Static wiring checks');
for (const note of notes) console.log(`  ${note}`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s) found:`);
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log('  PASS: markup, module graph and call sites all line up');
}
