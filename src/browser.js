import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { REGIONS, DOWNLOAD_DIR, merchantId, paidId } from './config.js';
import { SessionExpiredError } from './errors.js';
import { sleep } from './dates.js';
import { log } from './log.js';

const RETRYABLE = [
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_EMPTY_RESPONSE',
  'ERR_TIMED_OUT',
  'Timeout',
];

const isRetryable = (err) => RETRYABLE.some((code) => String(err?.message || '').includes(code));

/** Open a browser context for a region, restoring the saved cookies. */
export async function openRegion(regionKey, { headless = true } = {}) {
  const region = REGIONS[regionKey];
  if (!region) throw new Error(`Unknown region "${regionKey}". Use NA or EU.`);

  const hasState = existsSync(region.statePath);
  if (!hasState && headless) {
    throw new SessionExpiredError(regionKey);
  }

  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  mkdirSync(dirname(region.statePath), { recursive: true });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: hasState ? region.statePath : undefined,
    acceptDownloads: true,
    viewport: { width: 1500, height: 1000 },
    // Match the region so dates render the way parseRowDate expects them.
    locale: regionKey === 'EU' ? 'en-GB' : 'en-US',
  });
  const page = await context.newPage();

  return {
    region,
    browser,
    context,
    page,
    save: () => context.storageState({ path: region.statePath }),
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Navigate, retrying the transient Chromium network errors. ERR_NETWORK_CHANGED
 * in particular shows up on a laptop that switches wifi mid-run and is entirely
 * recoverable by simply asking again.
 */
export async function gotoWithRetry(page, url, { attempts = 4, waitUntil = 'domcontentloaded' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(url, { waitUntil, timeout: 60_000 });
      await assertSignedIn(page);
      return page;
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      lastErr = err;
      if (!isRetryable(err) || i === attempts) throw err;
      const backoff = 2000 * 2 ** (i - 1);
      log.warn(`network error (${err.message.split('\n')[0]}), retrying in ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * Expired cookies do not produce an error — they produce a perfectly good login
 * page, which a scraper will happily parse into zero rows. Detect the redirect
 * and stop the whole run.
 */
export async function assertSignedIn(page) {
  const url = page.url();
  if (url.includes('/ap/signin') || url.includes('/ap/mfa') || url.includes('signin?')) {
    const region = url.includes('.co.uk') || /amazon\.(de|fr|it|es)/.test(url) ? 'EU' : 'NA';
    throw new SessionExpiredError(region);
  }
}

/**
 * Marketplace-switch parameters.
 *
 *   mons_sel_dir_mcid  which seller account   amzn1.merchant.d.…
 *   mons_sel_mkid      which marketplace      amzn1.mp.o.…
 *
 * Both need their prefix; without it the switch silently no-ops and the page
 * serves whatever was selected before. They are easy to mix up — they sit
 * beside each other in the URL and have the same general shape — and swapping
 * them produces no error, just the wrong data.
 */
export function withMarketplace(mp, path) {
  // Always the region's own host, never the marketplace's.
  //
  // The session cookies are per-domain. Signing in on sellercentral.amazon.co.uk
  // gets you nothing on sellercentral.amazon.de — that host redirects straight
  // to /ap/signin and looks exactly like an expired session. One session per
  // region means one host per region; the marketplace is chosen by parameter,
  // not by domain.
  const url = new URL(path, `https://${REGIONS[mp.region].loginHost}`);
  url.searchParams.set('mons_sel_dir_mcid', merchantId(mp.code));
  url.searchParams.set('mons_sel_mkid', mp.marketplaceId);

  // Part of the URL Seller Central itself produces. Sent when known, omitted
  // when not — a wrong value here is worse than an absent one.
  const paid = paidId();
  if (paid) url.searchParams.set('mons_sel_dir_paid', paid);

  url.searchParams.set('ignore_selection_changed', 'true');
  return url.toString();
}

/**
 * How each marketplace names itself in the header picker, in the languages
 * Seller Central renders it in.
 */
export const MARKETPLACE_LABELS = {
  US: [/united states/i, /amazon\.com\b/i],
  CA: [/\bcanada\b/i, /amazon\.ca\b/i],
  UK: [/united kingdom/i, /amazon\.co\.uk\b/i],
  DE: [/\bgermany\b/i, /deutschland/i, /amazon\.de\b/i],
  FR: [/\bfrance\b/i, /amazon\.fr\b/i],
  IT: [/\bital(y|ia)\b/i, /amazon\.it\b/i],
  ES: [/\bspain\b/i, /espa[ñn]a/i, /amazon\.es\b/i],
};

/** Match a picker's visible text to a marketplace, or null if it names none. */
export function marketplaceFromLabel(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  for (const [code, patterns] of Object.entries(MARKETPLACE_LABELS)) {
    if (patterns.some((re) => re.test(clean))) return { code, label: clean.slice(0, 60) };
  }
  return null;
}

async function readMarketplacePicker(page) {
  const picker = page.locator([
    '#sc-mkt-picker-switcher-select',
    '[data-testid*="marketplace" i]',
    '[id*="mkt-picker" i]',
    '[aria-label*="marketplace" i]',
  ].join(', ')).first();

  if (!await picker.count().catch(() => 0)) return null;
  return marketplaceFromLabel(await picker.innerText().catch(() => ''));
}

/**
 * Select a marketplace, then land on the target page as a separate step.
 *
 * Doing the switch on the report URL itself is what produced a Canadian request
 * returning the US file: the page renders its report list before — or without —
 * the marketplace selection taking effect, so the list is whatever was selected
 * last. Switching on a neutral page first, and only then navigating, gives the
 * selection somewhere to land.
 */
export async function selectMarketplace(page, mp) {
  await gotoWithRetry(page, withMarketplace(mp, '/home'));
  await sleep(2000);
  return assertActiveMarketplace(page, mp);
}

/**
 * Read the active marketplace back off the page before trusting anything on it.
 *
 * Best-effort by design: it throws only on *contradicting* evidence (the page
 * says a different marketplace is selected), and warns when it finds no
 * evidence at all. Throwing on absence would block every run the first time
 * Amazon renames a data attribute.
 */
export async function assertActiveMarketplace(page, mp) {
  const bare = mp.marketplaceId.replace('amzn1.mp.o.', '');
  const others = Object.entries({
    US: 'ATVPDKIKX0DER',
    CA: 'A2EUQ1WTGCTBG2',
    UK: 'A1F83G8C2ARO7P',
    DE: 'A1PA6795UKMFR9',
    FR: 'A13V1IB3VIYZZH',
    IT: 'APJ6JRA9NG5V4',
    ES: 'A1RKKUPIHCS9HS',
  }).filter(([code]) => code !== mp.code);

  // Deliberately NOT checking page.url() for the marketplace id: we put it
  // there ourselves a moment ago, so finding it proves nothing. That check
  // reported "confirmed" on every run while the page served another
  // marketplace's data entirely.

  // The marketplace picker in the header names the current marketplace in
  // words. For DE/FR/IT/ES this is the only signal there is — they all share
  // the "-EU" SKU suffix, so the file itself cannot tell them apart.
  const picked = await readMarketplacePicker(page);
  if (picked) {
    if (picked.code === mp.code) {
      return { confirmed: true, how: `marketplace picker reads "${picked.label}"` };
    }
    const { MarketplaceMismatchError } = await import('./errors.js');
    throw new MarketplaceMismatchError(mp.code, {
      looksLike: picked.code,
      detail: `the marketplace picker reads "${picked.label}". The switch did not take effect.`,
    });
  }

  const html = await page.content().catch(() => '');
  const selectedPattern = (id) => new RegExp(
    `(selectedMarketplaceId|currentMarketplaceId|marketplaceId)"?\\s*[:=]\\s*"?(amzn1\\.mp\\.o\\.)?${id}`, 'i');

  if (selectedPattern(bare).test(html)) {
    return { confirmed: true, how: 'marketplace id embedded in the page as selected' };
  }

  for (const [code, id] of others) {
    if (selectedPattern(id).test(html)) {
      const { MarketplaceMismatchError } = await import('./errors.js');
      throw new MarketplaceMismatchError(mp.code, {
        looksLike: code,
        detail: `the page reports ${code} (${id}) as the selected marketplace. `
          + 'The marketplace switch did not take effect.',
      });
    }
  }

  return { confirmed: false, how: 'no marketplace evidence found on the page' };
}

/** Wait for a download triggered by `trigger`, returning its bytes. */
export async function captureDownload(page, trigger, { timeout = 180_000 } = {}) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout }),
    trigger(),
  ]);
  return { buffer: await readDownload(download), suggestedFilename: download.suggestedFilename() };
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function filenameFromResponse(res, url) {
  const disposition = res.headers()['content-disposition'] || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : url.split('/').pop().split('?')[0];
}

/**
 * Get the report bytes from any of several candidate controls.
 *
 * Two strategies per candidate, cheapest first:
 *
 *   1. Fetch the href directly through the browser's own request context, which
 *      shares its cookies. Deterministic — no click, no download event, no
 *      dependence on which element happens to be on top.
 *   2. Click it and wait for a download event.
 *
 * Trying several candidates matters because a click on the wrong element does
 * not fail — it silently does nothing, and the run hangs waiting for a download
 * that was never going to start. That is exactly what happened when a stray
 * link was clicked instead of the real Download button.
 */
export async function downloadReport(page, links, { perAttempt = 45_000 } = {}) {
  const problems = [];
  const startedAt = page.url();

  for (const link of links) {
    const label = (await link.innerText().catch(() => '') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40) || '(unlabelled)';
    const href = await link.getAttribute('href').catch(() => null);

    if (href && !/^#|^javascript:/i.test(href)) {
      const absolute = new URL(href, page.url()).toString();
      try {
        const res = await page.context().request.get(absolute, { timeout: perAttempt });
        const contentType = res.headers()['content-type'] || '';
        const body = res.ok() ? await res.body() : Buffer.alloc(0);

        // An HTML body means we fetched a page, not a report.
        if (body.length && !/text\/html/i.test(contentType)) {
          return {
            buffer: body,
            suggestedFilename: filenameFromResponse(res, absolute),
            how: `direct fetch via "${label}"`,
          };
        }
        problems.push(`"${label}": fetch gave ${res.status()} ${contentType || 'no content-type'}`);
      } catch (err) {
        problems.push(`"${label}": ${err.message.split('\n')[0]}`);
      }
    }

    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: perAttempt }),
        link.click({ timeout: 15_000 }),
      ]);
      return {
        buffer: await readDownload(download),
        suggestedFilename: download.suggestedFilename(),
        how: `click on "${label}"`,
      };
    } catch {
      problems.push(`"${label}": clicked, no download within ${perAttempt / 1000}s`);
      // A misfired click may have navigated; get back before trying the next one.
      if (page.url() !== startedAt) {
        await gotoWithRetry(page, startedAt).catch(() => {});
      }
    }
  }

  throw new Error(
    `None of the ${links.length} download candidate(s) produced a file:\n    `
    + problems.join('\n    '));
}
