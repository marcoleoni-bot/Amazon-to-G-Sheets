import {
  marketplace, FBA_INVENTORY_REPORT_PATH, REPORT_MAX_AGE_HOURS,
} from './config.js';
import {
  gotoWithRetry, withMarketplace, assertActiveMarketplace, captureDownload,
} from './browser.js';
import { INVENTORY } from './selectors-loader.js';
import { findFirst, toLocator } from './locate.js';
import { parseReport } from './parse.js';
import { verifyMarketplace } from './verify-marketplace.js';
import { sleep } from './dates.js';
import { log } from './log.js';

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = Number(process.env.REPORT_WAIT_MS || 15 * 60_000);

/**
 * Read the report table into something we can reason about. Report Central
 * lists newest first; each row is either still generating or carries a
 * download link.
 */
async function readReportRows(page) {
  const table = await findFirst(page, INVENTORY.reportTable, { timeout: 20_000 });
  if (!table) return [];

  const rows = table.locator.locator('tr');
  const count = await rows.count();
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    let link = null;
    for (const descriptor of INVENTORY.downloadLink) {
      const candidate = toLocator(row, descriptor).first();
      if (await candidate.count().catch(() => 0)) {
        if (await candidate.isVisible().catch(() => false)) { link = candidate; break; }
      }
    }

    const pending = INVENTORY.pendingText.some((re) => re.test(text));
    out.push({ index: i, text, link, pending, date: parseRowDate(text) });
  }
  return out;
}

/** Best-effort timestamp out of a row's text; null if we can't read one. */
function parseRowDate(text) {
  const patterns = [
    /(\d{1,2}\/\d{1,2}\/\d{4}[,\s]+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?)/i,
    /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2})/,
    /(\d{1,2}\.\d{1,2}\.\d{4}[,\s]+\d{1,2}:\d{2})/,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const d = new Date(m[1].replace(/(\d{1,2})\.(\d{1,2})\.(\d{4})/, '$3-$2-$1'));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

const ageHours = (d) => (d ? (Date.now() - d.getTime()) / 3_600_000 : null);

/**
 * Amazon regenerates these roughly every 30 minutes and throttles requests for
 * more. Forcing a brand-new report on all four marketplaces in one batch gets
 * you rate-limited; taking the newest ready one and *proving* it belongs to the
 * right marketplace gets you correct data without the fight.
 */
function pickReadyRow(rows) {
  const ready = rows.filter((r) => r.link && !r.pending);
  if (!ready.length) return null;

  const dated = ready.filter((r) => r.date);
  const newest = dated.length
    ? dated.reduce((a, b) => (a.date > b.date ? a : b))
    : ready[0]; // undated: trust the table's newest-first ordering

  const age = ageHours(newest.date);
  if (age !== null && age > REPORT_MAX_AGE_HOURS) return null;
  return { row: newest, ageHours: age };
}

export async function fetchInventory(page, code) {
  const mp = marketplace(code);
  const url = withMarketplace(mp, FBA_INVENTORY_REPORT_PATH);

  log.step(`${code} inventory — ${mp.host}`);
  await gotoWithRetry(page, url);

  const active = await assertActiveMarketplace(page, mp);
  if (!active.confirmed) {
    log.warn(`${code}: could not confirm the active marketplace from the page `
      + `(${active.how}); falling back to the SKU-suffix check on the downloaded file`);
  }

  let rows = await readReportRows(page);
  let pick = pickReadyRow(rows);

  if (!pick) {
    log.step(`${code}: no ready report within ${REPORT_MAX_AGE_HOURS}h — requesting a new one`);
    const button = await findFirst(page, INVENTORY.requestDownload, { timeout: 20_000 });
    if (!button) {
      throw new Error(
        `${code}: could not find the "Request .csv Download" button. Re-record with `
        + `npm run record:${mp.region.toLowerCase()} and update INVENTORY.requestDownload.`);
    }
    await button.locator.click();

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline && !pick) {
      await sleep(POLL_INTERVAL_MS);
      await gotoWithRetry(page, url);
      rows = await readReportRows(page);
      pick = pickReadyRow(rows);
      if (!pick) {
        const mins = Math.round((deadline - Date.now()) / 60_000);
        log.info(`${code}: still generating (${mins} min left)`);
      }
    }
    if (!pick) {
      throw new Error(`${code}: report was still generating after `
        + `${Math.round(POLL_TIMEOUT_MS / 60_000)} minutes.`);
    }
  }

  const age = pick.ageHours === null ? 'unknown age' : `${pick.ageHours.toFixed(1)}h old`;
  log.step(`${code}: downloading report (${age})`);

  const { buffer, suggestedFilename } = await captureDownload(
    page, () => pick.row.link.click());

  const parsed = parseReport(buffer);
  const check = verifyMarketplace({ code, header: parsed.header, rows: parsed.rows });

  log.ok(`${code} inventory — ${parsed.rows.length} rows, ${parsed.header.length} columns, `
    + `${parsed.delimiter}-separated; ${check.note}`);

  return {
    kind: 'inventory',
    code,
    mp,
    header: parsed.header,
    rows: parsed.rows,
    delimiter: parsed.delimiter,
    marketplaceCheck: check,
    activeMarketplaceCheck: active,
    filename: suggestedFilename,
  };
}
