/**
 * The README, checked against the code it describes.
 *
 * Documentation rots by default, and this project has the scars: the feature
 * list said "Four sample pieces are included" for as long as three had shipped,
 * the keyboard table has been missing four working shortcuts since they were
 * added, and the layout diagram named files that had been renamed. None of that
 * is visible to a test suite that only runs the code — a stale sentence passes
 * every check there is.
 *
 * Everything here is mechanical: a claim the README makes that can be read back
 * out of the source. Anything that cannot be checked this way is called out as
 * needing a person, in the README's own Tests section, rather than being left to
 * look verified.
 *
 * Run with: node tests/check-docs.js
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = join(ROOT, 'public');
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const appSource = readFileSync(join(SITE, 'js', 'app.js'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ------------------------------------------------------------- keyboard */

/**
 * The keys `handleKeydown` acts on, read out of its switch.
 *
 * Deliberately reads `event.code` cases rather than trusting a list: the point
 * is to notice a shortcut that was added and never written down, which a
 * hand-maintained list of expected keys could not do.
 */
function handledKeys() {
  // The method declaration, not the `this.handleKeydown(event)` call site above
  // it — slicing from the call gave the body of `bindKeyboard`, which has no
  // cases in it, so every documented key looked unhandled.
  const body = appSource.slice(appSource.indexOf('  handleKeydown(event) {'));
  const scope = body.slice(0, body.indexOf('\n  }\n'));
  const codes = [...scope.matchAll(/case '([A-Za-z]+)':/g)].map(match => match[1]);
  // '?' is matched on event.key rather than on a code, so it is not in the switch.
  if (/event\.key === '\?'/.test(appSource)) codes.push('Slash');
  return new Set(codes);
}

/** How a README table row spells a key, mapped to the code the app listens for. */
const KEY_CODES = new Map([
  ['space', 'Space'],
  ['←', 'ArrowLeft'],
  ['→', 'ArrowRight'],
  ['home', 'Home'],
  ['m', 'KeyM'],
  ['r', 'KeyR'],
  ['[', 'BracketLeft'],
  [']', 'BracketRight'],
  ['\\\\', 'Backslash'],
  ['\\', 'Backslash'],
  [',', 'Comma'],
  ['?', 'Slash']
]);

const documentedKeys = new Set();
for (const match of readme.matchAll(/<kbd>([^<]+)<\/kbd>/g)) {
  const code = KEY_CODES.get(match[1].trim().toLowerCase());
  if (!code) {
    fail(`README documents the key "${match[1]}", which this check does not know how to verify`);
    continue;
  }
  documentedKeys.add(code);
}

const handled = handledKeys();
for (const code of handled) {
  if (!documentedKeys.has(code)) {
    fail(`app.js handles ${code} but the README's keyboard table does not mention it`);
  }
}
for (const code of documentedKeys) {
  if (!handled.has(code)) {
    fail(`the README's keyboard table promises ${code}, which app.js does not handle`);
  }
}

// The in-app help sheet is the same promise made to somebody who never reads a
// README, so it has to carry the same keys.
const helpKeys = new Set();
const helpList = html.slice(html.indexOf('<ul class="help-list keys">'));
for (const match of helpList.slice(0, helpList.indexOf('</ul>')).matchAll(/<kbd>([^<]+)<\/kbd>/g)) {
  const code = KEY_CODES.get(match[1].trim().toLowerCase());
  if (code) helpKeys.add(code);
}
for (const code of handled) {
  if (!helpKeys.has(code)) {
    fail(`app.js handles ${code} but the in-app help sheet does not list it`);
  }
}

/* -------------------------------------------------------------- samples */

const bundled = readdirSync(join(SITE, 'sample-pieces'))
  .filter(name => /\.(musicxml|xml|mxl)$/i.test(name));

const offered = [...html.matchAll(/data-sample-path="sample-pieces\/([^"]+)"/g)]
  .map(match => decodeURIComponent(match[1]));

for (const name of bundled) {
  if (!offered.includes(name)) {
    fail(`${name} ships in public/sample-pieces/ but the home screen never offers it`);
  }
}
for (const name of offered) {
  if (!bundled.includes(name)) {
    fail(`the home screen offers ${name}, which is not in public/sample-pieces/`);
  }
}

// "Three samples ship in ..." has to be the number that actually ships.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
for (const match of readme.matchAll(/\b(\w+) samples? ship\b/gi)) {
  const claimed = WORDS.indexOf(match[1].toLowerCase());
  if (claimed !== bundled.length) {
    fail(`the README says "${match[0]}" but ${bundled.length} do`);
  }
}
for (const match of readme.matchAll(/\b(\w+) sample pieces are included\b/gi)) {
  const claimed = WORDS.indexOf(match[1].toLowerCase());
  if (claimed !== bundled.length) {
    fail(`the README says "${match[0]}" but ${bundled.length} are`);
  }
}

// Each score named in the Bundled scores table is a file that is really there.
const tableRows = readme.slice(readme.indexOf('| Score | Parts | Length'));
for (const row of tableRows.slice(0, tableRows.indexOf('\n\n')).split('\n').slice(2)) {
  const title = row.split('|')[1]?.trim();
  if (!title) continue;
  // File names use hyphens where a title uses spaces and punctuation, so both
  // sides are reduced to their letters and digits before comparing.
  const plain = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matched = bundled.some(name => plain(name).startsWith(plain(title)));
  if (!matched) {
    fail(`the README's score table lists "${title}", which is not a file in public/sample-pieces/`);
  }
}

/* ---------------------------------------------------------------- paths */

// Every path in the project-layout block, and every fixture named in prose.
const layout = readme.slice(readme.indexOf('```\npublic/index.html'));
const paths = new Set();
for (const line of layout.slice(0, layout.indexOf('\n```')).split('\n')) {
  const path = line.trim().split(/\s{2,}/)[0];
  if (path && /^[\w./-]+$/.test(path)) paths.add(path);
}
for (const match of readme.matchAll(/`(e2e\/fixtures\/[\w.-]+|tools\/[\w.-]+|[\w-]+\.jsonc?)`/g)) {
  paths.add(match[1]);
}
for (const path of paths) {
  if (!existsSync(join(ROOT, path))) {
    fail(`the README names ${path}, which does not exist`);
  }
}

/* -------------------------------------------------------------- scripts */

for (const match of readme.matchAll(/\bnpm run ([\w:]+)/g)) {
  if (!packageJson.scripts[match[1]]) {
    fail(`the README tells the reader to run "npm run ${match[1]}", which package.json does not define`);
  }
}
for (const match of readme.matchAll(/\bnode (tests\/[\w.-]+|tools\/[\w.-]+)/g)) {
  if (!existsSync(join(ROOT, match[1]))) {
    fail(`the README tells the reader to run "node ${match[1]}", which does not exist`);
  }
}

// `npm run check` is the command the README calls the whole thing, so every
// suite that exists has to be in it. A test file nobody runs is worse than none.
const check = packageJson.scripts.check || '';
for (const script of ['lint', 'test:static', 'test:docs', 'test:parser']) {
  if (!check.includes(script)) {
    fail(`package.json's "check" script does not run "${script}"`);
  }
}

/* --------------------------------------------------------- deploy surface */

// The README says the deploy surface is public/ and nothing else. If that ever
// stops being true the sentence is a security claim that has gone stale.
const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
if (!/"directory"\s*:\s*"\.\/public"/.test(wrangler)) {
  fail('wrangler.jsonc no longer publishes ./public, which the README says is the deploy surface');
}

/* ------------------------------------------------------------------ report */

notes.push(
  `checked ${documentedKeys.size} documented keys, ${bundled.length} samples, ${paths.size} paths`
);

console.log('Documentation checks');
for (const note of notes) console.log(`  ${note}`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s) found:`);
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log('  PASS: the README and the code agree');
}
