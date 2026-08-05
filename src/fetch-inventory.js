import {
  marketplace, FBA_INVENTORY_REPORT_PATH, REPORT_MAX_AGE_HOURS,
} from './config.js';
import {
  gotoWithRetry, withMarketplace, selectMarketplace, downloadReport,
} from './browser.js';
import { INVENTORY } from './selectors-loader.js';
import { findFirst, toLocator } from './locate.js';
import { parseReport } from './parse.js';
import { verifyMarketplace } from './verify-marketplace.js';
import { MarketplaceMismatchError } from './errors.js';
import { sleep } from './dates.js';
import { log } from './log.js';

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = Number(process.env.REPORT_WAIT_MS || 15 * 60_000);
const MAX_ATTEMPTS = Number(process.env.MARKETPLACE_ATTEMPTS || 3);

/**
 * Read the report table into something we can reason about. Report Central
 * lists newest first; each row is either still generating or carries a
 * download link.
 */
async function findDownloadLinks(scope) {
  const found = [];
  for (const descriptor of INVENTORY.downloadLink) {
    const candidate = toLocator(scope, descriptor).first();
    if (await candidate.count().catch(() => 0)) {
      if (await candidate.isVisible().catch(() => false)) found.push(candidate);
    }
  }
  return found;
}

/**
 * Read the report table into something we can reason about. Report Central
 * lists newest first; each row is either still generating or carries a
 * download link.
 *
 * Falls back to a page-wide link scan when the list is not a <table> — Report
 * Central has been rebuilt in div-based components before and will be again,
 * and refusing to see a ready report because it is not in a <tr> is a bad way
 * to spend fifteen minutes.
 */
async function readReportRows(page, dayFirst = false) {
  const table = await findFirst(page, INVENTORY.reportTable, { timeout: 20_000 });

  if (table) {
    const rows = table.locator.locator('tr');
    const count = await rows.count();
    const out = [];

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const links = await findDownloadLinks(row);
      const pending = INVENTORY.pendingText.some((re) => re.test(text));
      out.push({ index: i, text, links, pending, date: parseRowDate(text, dayFirst) });
    }
    if (out.some((r) => r.links.length)) return out;
  }

  // Nothing usable in a table — is there a download link anywhere on the page?
  const loose = await findDownloadLinks(page);
  if (loose.length) {
    const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    return [{ index: 0, text, links: loose, pending: false, date: parseRowDate(text, dayFirst) }];
  }

  return table ? [] : [];
}

/** What the page actually showed, for when the poller finds nothing. */
async function describePage(page, rows) {
  const lines = [];
  lines.push(`rows seen: ${rows.length}, with a download link: ${rows.filter((r) => r.links?.length).length}`);
  for (const r of rows.slice(0, 6)) {
    lines.push(`  [${r.links?.length ? 'link' : '    '}${r.pending ? ' pending' : ''}] ${r.text.slice(0, 120)}`);
  }
  const anchors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, button'))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 25)).catch(() => []);
  if (anchors.length) lines.push(`  clickable labels: ${anchors.join(' | ')}`);
  return lines.join('\n');
}

/**
 * Best-effort timestamp out of a row's text; null if we can't read one.
 *
 * `dayFirst` matters more than it looks. Europe writes 05/08/2026 for 5 August
 * and North America writes it for 8 May. Guess wrong and a report generated
 * minutes ago reads as three months old, gets rejected as stale, and the bot
 * waits for a fresh one that already exists.
 */
export function parseRowDate(text, dayFirst = false) {
  const isoMatch = String(text).match(/(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}))?/);
  if (isoMatch) {
    const d = new Date(`${isoMatch[1]}T${isoMatch[2] || '00:00'}Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const m = String(text).match(
    /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;

  const [, a, b, year, hh = '0', mm = '0', ampm] = m;
  let day = dayFirst ? Number(a) : Number(b);
  let month = dayFirst ? Number(b) : Number(a);

  // Self-correct when the assumed order is impossible: 25/12 can only be
  // day-first however the page is meant to be read.
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month > 12 || day > 31) return null;

  let hours = Number(hh);
  if (/pm/i.test(ampm || '') && hours < 12) hours += 12;
  if (/am/i.test(ampm || '') && hours === 12) hours = 0;

  const d = new Date(Date.UTC(Number(year), month - 1, day, hours, Number(mm)));
  return Number.isNaN(d.getTime()) ? null : d;
}

const ageHours = (d) => (d ? (Date.now() - d.getTime()) / 3_600_000 : null);

/**
 * Amazon regenerates these roughly every 30 minutes and throttles requests for
 * more. Forcing a brand-new report on all four marketplaces in one batch gets
 * you rate-limited; taking the newest ready one and *proving* it belongs to the
 * right marketplace gets you correct data without the fight.
 */
function pickReadyRow(rows, alreadyTried = new Set()) {
  const ready = rows.filter((r) => r.links?.length && !r.pending && !alreadyTried.has(r.text));
  if (!ready.length) return null;

  const dated = ready.filter((r) => r.date);
  const newest = dated.length
    ? dated.reduce((a, b) => (a.date > b.date ? a : b))
    : ready[0]; // undated: trust the table's newest-first ordering

  const age = ageHours(newest.date);
  if (age !== null && age > REPORT_MAX_AGE_HOURS) return null;
  return { row: newest, ageHours: age };
}

/** Ask Report Central to generate a fresh report for the selected marketplace. */
async function requestFresh(page, code, region) {
  const button = await findFirst(page, INVENTORY.requestDownload, { timeout: 20_000 });
  if (!button) {
    throw new Error(
      `${code}: could not find the "Request .csv Download" button. Re-record with `
      + `npm run record:${region.toLowerCase()} and update INVENTORY.requestDownload.`);
  }
  await button.locator.click();
}

/** Poll until a ready report appears that we have not already rejected. */
async function waitForReport(page, code, url, dayFirst, tried) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let rows = [];
  let polls = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    await gotoWithRetry(page, url);
    rows = await readReportRows(page, dayFirst);
    const pick = pickReadyRow(rows, tried);
    if (pick) return pick;
    polls += 1;

    const mins = Math.round((deadline - Date.now()) / 60_000);
    const ready = rows.filter((r) => r.links?.length).length;
    // Say why, not just how long. A ready report the selectors cannot see looks
    // exactly like a report that is not ready, and the difference matters.
    log.info(`${code}: no new downloadable report yet — ${rows.length} row(s), `
      + `${ready} with a download link (${mins} min left)`);
    if (polls === 2 || polls === 6) {
      log.warn(`${code}: if a report looks ready in the browser, the selectors are missing it:`);
      console.error(await describePage(page, rows));
    }
  }

  throw new Error(`${code}: no downloadable report after `
    + `${Math.round(POLL_TIMEOUT_MS / 60_000)} minutes.\n`
    + `${await describePage(page, rows)}\n`
    + '  If a report IS ready in the browser, this is a selector problem, not a timing\n'
    + '  one — update INVENTORY.downloadLink in src/selectors.js.');
}

/**
 * Fetch, verify, and retry on contamination.
 *
 * Selecting a marketplace does not reliably determine which marketplace's file
 * Report Central hands back. The same UK request returned a clean UK file on one
 * run and an EU file thirty minutes later, from identical code. So the ready
 * report is a candidate, not an answer: download it, prove it belongs to the
 * marketplace we asked for, and if it does not, reject that row and try again —
 * first any other ready report, then a freshly generated one.
 *
 * Requesting a fresh report is the reliable move but also the throttled one, so
 * it is the fallback rather than the default.
 */
export async function fetchInventory(page, code) {
  const mp = marketplace(code);
  const url = withMarketplace(mp, FBA_INVENTORY_REPORT_PATH);
  const dayFirst = mp.region === 'EU';

  log.step(`${code} inventory — ${mp.marketplaceId}`);

  // Switch first, land second. Combining the two served the wrong marketplace.
  const active = await selectMarketplace(page, mp);
  await gotoWithRetry(page, url);

  if (!active.confirmed) {
    log.warn(`${code}: could not confirm the active marketplace from the page `
      + `(${active.how}); relying on the SKU check of the downloaded file`);
  }

  const tried = new Set();
  let lastMismatch = null;
  let rowsCache = await readReportRows(page, dayFirst);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let pick = pickReadyRow(rowsCache, tried);
    if (!pick) {
      rowsCache = await readReportRows(page, dayFirst);
      pick = pickReadyRow(rowsCache, tried);
    }

    if (!pick) {
      log.step(`${code}: requesting a fresh report (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await requestFresh(page, code, mp.region);
      pick = await waitForReport(page, code, url, dayFirst, tried);
    }

    const age = pick.ageHours === null ? 'unknown age' : `${pick.ageHours.toFixed(1)}h old`;
    log.step(`${code}: downloading report (${age})`);

    const { buffer, suggestedFilename, how } = await downloadReport(page, pick.row.links);
    log.step(`${code}: got ${suggestedFilename || 'report'} by ${how}`);

    const parsed = parseReport(buffer);

    try {
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
        attempts: attempt,
      };
    } catch (err) {
      if (!(err instanceof MarketplaceMismatchError)) throw err;

      lastMismatch = err;
      tried.add(pick.row.text);
      log.warn(`${code}: attempt ${attempt} got the wrong marketplace `
        + `(looks like ${err.evidence.looksLike}) — rejecting that report and retrying`);

      // Re-select before the next attempt; the selection may be what drifted.
      await selectMarketplace(page, mp);
      await gotoWithRetry(page, url);
      rowsCache = await readReportRows(page, dayFirst);
    }
  }

  throw new Error(
    `${code}: could not obtain a report for the right marketplace in ${MAX_ATTEMPTS} attempts.\n`
    + `  Last mismatch: ${lastMismatch?.message}\n`
    + '  Nothing was written. This is the contamination guard doing its job — the data\n'
    + '  Report Central served did not belong to the marketplace that was requested.');
}
