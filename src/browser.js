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
  const url = new URL(path, `https://${mp.host}`);
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

  if (page.url().includes(bare)) {
    return { confirmed: true, how: 'marketplace id present in the URL' };
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
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    suggestedFilename: download.suggestedFilename(),
  };
}
