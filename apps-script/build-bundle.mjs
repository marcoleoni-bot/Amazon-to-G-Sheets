/**
 * Concatenates the modules into one paste-able file.
 *
 * Apps Script already runs every .gs in a single global scope, so a bundle is
 * not a build step in any meaningful sense — it exists purely so installing by
 * hand is one paste instead of ten, which is the difference between a five
 * minute setup and a fiddly one.
 *
 *   node apps-script/build-bundle.mjs
 *
 * Edit the modules, never dist/Code.gs. The bundle is regenerated and the
 * check below fails the build if it has drifted.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Order is cosmetic — nothing reads another file's globals at load time — but
// keeping it stable makes the bundle diffable.
const ORDER = ['Config.gs', 'Lib.gs', 'Rules_AwdToFba.gs', 'Rules_TacToAwd.gs',
  'Rules_TacToFba.gs', 'Allocate.gs', 'Read.gs', 'Write.gs', 'Backtest.gs',
  'Authorise.gs', 'Refresh.gs', 'History.gs', 'Menu.gs'];

const banner = [
  '/**',
  ' * US Transfer Order Planner — all modules in one file.',
  ' *',
  ' * GENERATED. Do not edit here; edit apps-script/<Module>.gs and re-run',
  ' *   node apps-script/build-bundle.mjs',
  ' *',
  ' * Paste this into Extensions > Apps Script as a single file, reload the',
  ' * spreadsheet, and the Transfer Orders menu appears.',
  ' */',
  '',
].join('\n');

const body = ORDER.map((name) => {
  const src = readFileSync(join(HERE, name), 'utf8').trimEnd();
  return `// ${'='.repeat(72)}\n// ${name}\n// ${'='.repeat(72)}\n\n${src}\n`;
}).join('\n');

mkdirSync(join(HERE, 'dist'), { recursive: true });
writeFileSync(join(HERE, 'dist', 'Code.gs'), `${banner}${body}`);
console.log(`apps-script/dist/Code.gs  <-  ${ORDER.length} modules`);
