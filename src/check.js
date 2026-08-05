import { existsSync, statSync } from 'node:fs';
import {
  REGIONS, MARKETPLACES, INVENTORY_PULLS, SALES_TABS, WINDOWS, SPREADSHEET_ID, INCLUSIVE_END,
} from './config.js';
import { listSchemas } from './schema-store.js';
import { SALES, salesRecorded } from './selectors.js';
import { usingLocalOverride } from './selectors-loader.js';
import { connect, listTabs } from './sheets.js';
import { windowFor } from './dates.js';
import { log, heading } from './log.js';

/**
 * Preflight. Answers "would `npm start` work right now, and if not, what's
 * missing" without touching Amazon or the spreadsheet's contents.
 */

let problems = 0;
const bad = (msg) => { problems += 1; log.fail(msg); };

heading('Sessions');
for (const [key, region] of Object.entries(REGIONS)) {
  if (!existsSync(region.statePath)) {
    bad(`${key}: no ${region.statePath} — run  npm run login -- ${key}`);
  } else {
    const ageDays = (Date.now() - statSync(region.statePath).mtimeMs) / 86_400_000;
    const msg = `${key}: ${region.statePath}, ${ageDays.toFixed(0)} days old`;
    if (ageDays > 21) log.warn(`${msg} — Amazon expires these every 2-4 weeks`);
    else log.ok(msg);
  }
}

heading('Merchant IDs');
for (const [key, region] of Object.entries(REGIONS)) {
  if (process.env[region.merchantIdEnv]) log.ok(`${key}: ${region.merchantIdEnv} set`);
  else bad(`${key}: ${region.merchantIdEnv} not set — read mons_sel_dir_mcid out of the URL `
    + 'after switching marketplace once in the browser');
}

heading('Marketplaces');
for (const mp of Object.values(MARKETPLACES)) {
  if (!mp.marketplaceId.startsWith('amzn1.mp.o.')) {
    bad(`${mp.code}: marketplace id is missing the amzn1.mp.o. prefix — switching will silently no-op`);
  }
}
log.ok(`${Object.keys(MARKETPLACES).length} marketplaces configured, all prefixed`);

heading('Schema baselines');
const schemas = listSchemas();
if (!schemas.length) bad('none recorded — run  npm run baseline -- inventory US');
for (const s of schemas) {
  const line = `${s.key}: ${s.columnCount} columns, recorded ${s.recordedAt.slice(0, 10)}`;
  if (s.provisional) log.warn(`${line} — PROVISIONAL, not yet verified against a real download`);
  else log.ok(line);
}

heading('Sales click path');
for (const key of Object.keys(REGIONS)) {
  const cfg = SALES[key];
  if (cfg?.jsonEndpoint) log.ok(`${key}: JSON endpoint recorded (most durable route)`);
  else if (cfg?.steps?.length) log.ok(`${key}: ${cfg.steps.length} recorded click step(s)`);
  else if (salesRecorded(key)) {
    log.warn(`${key}: only the unverified direct-URL templates — if those 404, record the `
      + `real path with  npm run record:${key.toLowerCase()}`);
  } else bad(`${key}: nothing recorded — npm run record:${key.toLowerCase()}`);
}
if (usingLocalOverride) log.info('src/selectors.local.js is overriding src/selectors.js');

heading('Date windows');
log.info(`INCLUSIVE_END = ${INCLUSIVE_END}`);
for (const days of WINDOWS) {
  const w = windowFor(days);
  log.info(`  ${String(days).padStart(2)}d → ${w.start} .. ${w.end}`);
}
log.warn('Verify these against one manual download before trusting any velocity figure.');

heading('Spreadsheet');
const wanted = [
  ...INVENTORY_PULLS.map((p) => p.tab),
  ...SALES_TABS.flatMap((t) => WINDOWS.map((d) => `${t.tab} ${d}`)),
];
try {
  const { api, serviceAccountEmail } = await connect();
  if (serviceAccountEmail) log.info(`service account: ${serviceAccountEmail}`);
  const tabs = await listTabs(api);
  const missing = wanted.filter((t) => !tabs.includes(t));
  if (missing.length) bad(`missing tabs: ${missing.join(', ')}`);
  else log.ok(`all ${wanted.length} tabs present in ${SPREADSHEET_ID}`);
} catch (err) {
  bad(err.message);
}

log.blank();
if (problems) {
  log.fail(`${problems} problem(s) — npm start would not get through a full run yet.`);
  process.exit(1);
}
log.ok('Ready.');
