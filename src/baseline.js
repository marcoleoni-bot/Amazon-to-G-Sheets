import readline from 'node:readline/promises';
import { fetchAll } from './runner.js';
import { schemaKey, saveSchema, loadSchema } from './schema-store.js';
import { diffHeader, columnLetter } from './guard.js';
import { marketplace } from './config.js';
import { log, heading } from './log.js';

/**
 * Record — or accept a change to — a schema baseline.
 *
 *   npm run baseline -- inventory US      # records schemas/inventory.NA.json
 *   npm run baseline -- inventory UK      # records schemas/inventory.EU.json
 *   npm run baseline -- sales US 30       # records schemas/sales.json
 *
 * This is the only thing that can make the guard stop complaining, and it asks
 * for confirmation first. That friction is the point: accepting a baseline is
 * the moment someone decides Amazon's new layout is fine, and Calc_Data's
 * column letters may need moving to match.
 */

const [kind, code, daysArg] = process.argv.slice(2);
if (!['inventory', 'sales'].includes(kind) || !code) {
  console.error('Usage: npm run baseline -- inventory US   |   npm run baseline -- sales US 30');
  process.exit(2);
}

const mp = marketplace(code.toUpperCase());
const days = kind === 'sales' ? Number(daysArg || 30) : undefined;
const key = schemaKey(kind, mp);

log.info(`Fetching one ${kind} report from ${mp.code} to record baseline "${key}"`);

const [result] = await fetchAll(
  [{ kind, marketplace: mp.code, days }],
  { headless: !process.env.HEADED });

heading(`Header (${result.header.length} columns)`);
result.header.forEach((h, i) => {
  console.log(`  ${String(i + 1).padStart(2)} ${columnLetter(i + 1).padEnd(3)} ${h}`);
});

const previous = loadSchema(key);
if (previous) {
  const diff = diffHeader(previous.columns, result.header);
  heading(previous.provisional ? 'Against the provisional baseline' : 'Against the current baseline');
  if (diff.ok) {
    log.ok('identical — nothing to change');
    process.exit(0);
  }
  console.log(diff.report);
  if (!previous.provisional) {
    log.blank();
    log.warn('This is a real schema change. Before accepting it, check whether Calc_Data\'s');
    log.warn('column letters still point at the columns you think they do.');
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nRecord this as the baseline for "${key}"? [y/N] `);
rl.close();

if (answer.trim().toLowerCase() !== 'y') {
  log.info('Left unchanged.');
  process.exit(0);
}

saveSchema(key, result.header, {
  provisional: false,
  note: `recorded from a ${mp.code} ${kind} download`,
});
log.ok(`Wrote schemas/${key}.json (${result.header.length} columns)`);
