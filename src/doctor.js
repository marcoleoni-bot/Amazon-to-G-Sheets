import { writeFileSync } from 'node:fs';
import { INVENTORY_PULLS, REGIONS, merchantId, paidId, MERCHANT_CACHE } from './config.js';
import { openRegion } from './browser.js';
import { fetchInventory } from './fetch-inventory.js';
import { validateSchema, columnLetter } from './guard.js';
import { log, heading } from './log.js';

/**
 * One command that exercises everything and writes a single report.
 *
 * The alternative was a person running six commands and pasting six outputs,
 * once per round of diagnosis. This runs the whole inventory half, keeps going
 * past failures instead of stopping at the first, and captures what the page
 * actually looked like when something went wrong — so one run answers the
 * questions that used to take three.
 *
 *   npm run doctor              # all four inventory marketplaces
 *   npm run doctor -- US CA     # just these
 *   HEADED=1 npm run doctor     # watch it
 *
 * Writes doctor-report.txt. Merchant and payment IDs are redacted; SKUs are
 * not, because the SKU suffixes are what the marketplace check reasons about.
 */

const only = process.argv.slice(2).map((s) => s.toUpperCase()).filter(Boolean);
const targets = only.length
  ? INVENTORY_PULLS.filter((p) => only.includes(p.marketplace))
  : INVENTORY_PULLS;

if (!targets.length) {
  console.error('Usage: npm run doctor [-- US CA UK DE]');
  process.exit(2);
}

const report = [];
const say = (line = '') => {
  report.push(line);
  console.log(line);
};

/** Keep account identifiers out of a file that is going to get pasted around. */
function redact(text) {
  let out = String(text);
  for (const region of Object.keys(REGIONS)) {
    try {
      const id = merchantId(region === 'NA' ? 'US' : 'UK');
      out = out.split(id).join('<merchant-id>');
    } catch { /* not configured; nothing to hide */ }
  }
  const paid = paidId();
  if (paid) out = out.split(paid).join('<paid-id>');
  return out;
}

/**
 * What the page looks like right now — the things I keep having to ask for:
 * the marketplace picker's text, and the labels of everything clickable.
 */
async function snapshot(page) {
  const lines = [];
  try {
    lines.push(`  url: ${page.url().split('?')[0]}`);

    const picker = await page.evaluate(() => {
      const hits = [];
      const selectors = ['#sc-mkt-picker-switcher-select', '[data-testid*="marketplace" i]',
        '[id*="mkt-picker" i]', '[id*="picker" i]', '[aria-label*="marketplace" i]',
        'header', '[role="banner"]'];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 2)) {
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          if (text) hits.push(`${sel} → ${text}`);
        }
      }
      return hits.slice(0, 8);
    });
    if (picker.length) {
      lines.push('  marketplace picker candidates:');
      for (const p of picker) lines.push(`    ${p}`);
    } else {
      lines.push('  marketplace picker candidates: none matched');
    }

    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 40)
        .slice(0, 30));
    if (labels.length) lines.push(`  clickable labels: ${labels.join(' | ')}`);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tr')).slice(0, 6)
        .map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140))
        .filter(Boolean));
    if (rows.length) {
      lines.push('  first table rows:');
      for (const r of rows) lines.push(`    ${r}`);
    }
  } catch (err) {
    lines.push(`  (could not read the page: ${err.message.split('\n')[0]})`);
  }
  return lines.join('\n');
}

const results = [];

for (const regionKey of ['NA', 'EU']) {
  const forRegion = targets.filter((t) =>
    (regionKey === 'NA' ? ['US', 'CA'] : ['UK', 'DE']).includes(t.marketplace));
  if (!forRegion.length) continue;

  heading(`${regionKey} — ${forRegion.map((t) => t.marketplace).join(', ')}`);
  report.push(`\n=== ${regionKey} ===`);

  let session;
  try {
    session = await openRegion(regionKey, { headless: !process.env.HEADED });
  } catch (err) {
    say(`  ✗ cannot open the ${regionKey} session: ${err.message.split('\n')[0]}`);
    say(`    → npm run login -- ${regionKey}`);
    for (const t of forRegion) results.push({ code: t.marketplace, ok: false, why: 'no session' });
    continue;
  }

  for (const { marketplace: code, tab } of forRegion) {
    say('');
    say(`--- ${code} → "${tab}" ---`);
    try {
      const r = await fetchInventory(session.page, code);
      say(`  ✓ ${r.rows.length} rows, ${r.header.length} columns, ${r.delimiter}-separated`);
      say(`    marketplace: ${r.marketplaceCheck.note}`);
      say(`    page check:  ${r.activeMarketplaceCheck.how}`);
      say(`    attempts:    ${r.attempts}`);

      try {
        const { key, baseline } = validateSchema({
          kind: 'inventory', mp: r.mp, header: r.header, label: `${code} inventory`,
        });
        const transfer = r.header.indexOf('afn-fc-transfer-quantity') + 1;
        say(`  ✓ schema matches "${key}"${baseline.provisional ? ' (provisional)' : ''}; `
          + `afn-fc-transfer-quantity at ${transfer}/${columnLetter(transfer)}`);
        results.push({ code, ok: true, rows: r.rows.length, columns: r.header.length });
      } catch (err) {
        say(`  ✗ schema: ${err.message}`);
        say(`    header as downloaded:`);
        r.header.forEach((h, i) => say(`      ${String(i + 1).padStart(2)} ${columnLetter(i + 1).padEnd(3)} ${h}`));
        results.push({ code, ok: false, why: 'schema changed' });
      }
    } catch (err) {
      say(`  ✗ ${err.message}`);
      say(await snapshot(session.page));
      results.push({ code, ok: false, why: err.name || 'failed' });
    }
  }

  await session.save().catch(() => {});
  await session.close();
}

heading('Summary');
for (const r of results) {
  const line = r.ok
    ? `  ✓ ${r.code.padEnd(3)} ${r.rows} rows, ${r.columns} columns`
    : `  ✗ ${r.code.padEnd(3)} ${r.why}`;
  say(line);
}

const failed = results.filter((r) => !r.ok).length;
say('');
say(failed
  ? `${failed} of ${results.length} marketplaces failed. Nothing was written to the spreadsheet.`
  : `All ${results.length} marketplaces fetched and validated. Nothing was written — this is a dry run.`);

writeFileSync('doctor-report.txt', `${redact(report.join('\n'))}\n`);
log.blank();
log.info('Full report written to doctor-report.txt (merchant IDs redacted).');
log.info('If anything failed, send me that file — it has what I need in one place.');

process.exit(failed ? 1 : 0);
