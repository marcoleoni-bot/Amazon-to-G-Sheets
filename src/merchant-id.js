import { MARKETPLACES } from './config.js';

/**
 * Merchant token discovery.
 *
 * Settings → Account Info → Merchant Token is gated to the primary account
 * holder, so a secondary user cannot read their own token from the UI. But the
 * token is all over the signed-in HTML — every marketplace-switcher link
 * carries it — so a live session can simply read it.
 */

/** Amazon marketplace IDs share the merchant-token shape and must not be mistaken for one. */
const MARKETPLACE_IDS = new Set(
  Object.values(MARKETPLACES).map((m) => m.marketplaceId.replace('amzn1.mp.o.', '')));

const TOKEN = '[A-Z0-9]{12,20}';

/** Ordered by how much the surrounding context proves it really is the merchant. */
const PATTERNS = [
  { name: 'marketplace-switcher link', re: new RegExp(`mons_sel_dir_mcid=(${TOKEN})`, 'g') },
  { name: 'mcid parameter', re: new RegExp(`[?&]mcid=(${TOKEN})`, 'g') },
  { name: 'merchantId field', re: new RegExp(`"merchant(?:_i|I)d"\\s*:\\s*"(${TOKEN})"`, 'g') },
  { name: 'sellerId field', re: new RegExp(`"seller(?:_i|I)d"\\s*:\\s*"(${TOKEN})"`, 'g') },
  { name: 'merchantCustomerId field', re: new RegExp(`"merchantCustomerId"\\s*:\\s*"(${TOKEN})"`, 'g') },
  { name: 'ld_mcid cookie value', re: new RegExp(`ld_mcid["'=:\\s]+(${TOKEN})`, 'g') },
];

/** A plausible merchant token: starts with A, uppercase alphanumeric, right length. */
export function looksLikeToken(value) {
  return /^A[A-Z0-9]{11,19}$/.test(String(value || ''));
}

/** Reject the placeholder from the setup instructions rather than sending it to Amazon. */
export function isPlaceholder(value) {
  return /^A\d?X{6,}$/i.test(String(value || ''));
}

/**
 * Scan a page's HTML (and optionally its cookies) for merchant-token candidates.
 * Returns candidates ranked by how many independent places each was found in.
 */
export function extractMerchantIds(html, cookies = []) {
  const hits = new Map(); // token -> Set of source names

  const record = (token, source) => {
    if (!looksLikeToken(token) || MARKETPLACE_IDS.has(token)) return;
    if (!hits.has(token)) hits.set(token, new Set());
    hits.get(token).add(source);
  };

  for (const { name, re } of PATTERNS) {
    for (const m of String(html || '').matchAll(re)) record(m[1], name);
  }

  for (const cookie of cookies) {
    if (/mcid|merchant|seller/i.test(cookie.name || '')) {
      for (const part of String(cookie.value || '').split(/[^A-Z0-9]+/i)) {
        record(part, `cookie ${cookie.name}`);
      }
    }
  }

  return [...hits.entries()]
    .map(([token, sources]) => ({ token, sources: [...sources] }))
    .sort((a, b) => b.sources.length - a.sources.length);
}

/**
 * Discover the merchant token for a live signed-in page.
 *
 * The marketplace switcher is opened first when present: its links are the
 * highest-confidence source, and on some pages it is rendered lazily.
 */
export async function discoverMerchantId(page, host) {
  const scan = async () => {
    const html = await page.content().catch(() => '');
    const cookies = await page.context().cookies().catch(() => []);
    return extractMerchantIds(html, cookies);
  };

  let candidates = await scan();

  if (!candidates.length) {
    // Nudge the switcher open — its menu is where the token most reliably lives.
    const switcher = page.locator(
      'button:has-text("Amazon."), [data-testid*="marketplace"], #sc-mkt-picker-switcher-select')
      .first();
    if (await switcher.count().catch(() => 0)) {
      await switcher.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      candidates = await scan();
    }
  }

  return { host, candidates };
}
