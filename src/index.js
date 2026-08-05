import { INVENTORY_PULLS, SALES_PULLS, SPREADSHEET_ID } from './config.js';
import { fetchAll } from './runner.js';
import { validateAndAssemble } from './assemble.js';
import { connect, listTabs, assertTabsExist, clearAndWrite } from './sheets.js';
import { alert } from './alert.js';
import { log, heading } from './log.js';

/**
 * Full run, strictly two-phase.
 *
 * Everything is fetched and validated before anything is written. A run that
 * writes eight tabs and then discovers Amazon changed a column leaves the sheet
 * half old and half new, and Calc_Data will average across both without
 * complaint. Better to write nothing and say why.
 */

const started = Date.now();

async function main() {
  const specs = [
    ...INVENTORY_PULLS.map((p) => ({ kind: 'inventory', marketplace: p.marketplace })),
    ...SALES_PULLS.map((p) => ({ kind: 'sales', marketplace: p.marketplace, days: p.days })),
  ];

  heading(`Phase 1 — fetch (${specs.length} pulls)`);
  const results = await fetchAll(specs, { headless: true });

  heading('Phase 2 — validate');
  const { ok, failures, notes, tabs } = validateAndAssemble(results);

  for (const note of notes) log.warn(note);

  if (!ok) {
    log.blank();
    log.fail(`${failures.length} report(s) failed validation. Nothing has been written.`);
    for (const f of failures) {
      console.error(`\n── ${f.label} ──\n${f.error.message}`);
    }
    await alert('amazon-report-bot: validation failed, sheet untouched',
      failures.map((f) => `${f.label}: ${f.error.message}`).join('\n\n'));
    process.exit(1);
  }

  log.ok(`all ${results.length} reports match their baselines`);

  const blockLevel = results.filter((r) => r.marketplaceCheck?.blockLevelOnly
    && !r.activeMarketplaceCheck?.confirmed);
  if (blockLevel.length) {
    log.warn(`${blockLevel.length} EU-pool pull(s) verified at block level only `
      + '(SKU suffixes cannot tell DE/FR/IT/ES apart and the page gave no marketplace signal)');
  }

  heading(`Phase 3 — write (${tabs.length} tabs)`);
  const { api, serviceAccountEmail } = await connect();
  if (serviceAccountEmail) log.info(`service account: ${serviceAccountEmail}`);

  const existing = await listTabs(api);
  assertTabsExist(existing, tabs.map((t) => t.tab));

  for (const t of tabs) {
    const written = await clearAndWrite(api, t.tab, t.rows);
    log.ok(`${t.tab.padEnd(16)} ${String(written.rows).padStart(5)} rows  [${t.sources.join(', ')}]`);
  }

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  heading('Done');
  log.ok(`${tabs.length} tabs written in ${mins} min`);
  log.info(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
}

try {
  await main();
} catch (err) {
  log.blank();
  log.fail(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  await alert(`amazon-report-bot: ${err.name || 'run failed'}`, err.message);
  process.exit(1);
}
