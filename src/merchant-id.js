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
  { name: 'merchantToken field', re: new RegExp(`"merchantToken"\\s*:\\s*"(${TOKEN})"`, 'g') },
  { name: 'encodedMerchantId field', re: new RegExp(`"encodedMerchantId"\\s*:\\s*"(${TOKEN})"`, 'g') },
  { name: 'data-merchant attribute', re: new RegExp(`data-merchant(?:-id)?=["'](${TOKEN})["']`, 'g') },
  { name: 'sellerId parameter', re: new RegExp(`[?&](?:sellerId|seller)=(${TOKEN})`, 'g') },
  { name: 'merchant path segment', re: new RegExp(`/(?:merchant|seller)/(${TOKEN})\\b`, 'g') },
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
 * Gather every place on a rendered page a token might hide.
 *
 * page.content() alone is not enough: Seller Central's header — where the
 * marketplace-switcher links live, the best source there is — is rendered
 * client-side, so a scan at domcontentloaded sees a shell with nothing in it.
 * Reading hrefs and storage out of the live DOM catches what the HTML string
 * misses.
 */
async function gather(page) {
  const html = await page.content().catch(() => '');

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href], form[action]'))
      .map((el) => el.getAttribute('href') || el.getAttribute('action'))
      .join('\n')).catch(() => '');

  const storage = await page.evaluate(() => {
    const out = [];
    for (const store of ['localStorage', 'sessionStorage']) {
      try {
        const s = window[store];
        for (let i = 0; i < s.length; i += 1) out.push(`${s.key(i)}=${s.getItem(s.key(i))}`);
      } catch { /* storage can be blocked; not fatal */ }
    }
    return out.join('\n');
  }).catch(() => '');

  const cookies = await page.context().cookies().catch(() => []);
  return { text: [html, hrefs, storage, page.url()].join('\n'), cookies };
}

/** Signed-out pages render fine and simply contain no token — worth telling apart. */
export function looksSignedOut(text) {
  return /ap\/signin|Sign in to continue|Amazon Sign[- ]In|<title>[^<]*Sign[- ]?In/i.test(text)
    && !/mons_sel_dir_mcid|Seller Central Home/i.test(text);
}

/**
 * Discover the merchant token for a live signed-in page.
 *
 * Scans, waits, scans again — the header populates asynchronously and the first
 * look is often too early. Only then does it try opening the switcher.
 */
export async function discoverMerchantId(page, host, { attempts = 3 } = {}) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  let last = { text: '', cookies: [] };

  for (let i = 0; i < attempts; i += 1) {
    last = await gather(page);
    const candidates = extractMerchantIds(last.text, last.cookies);
    if (candidates.length) return { host, candidates, signedOut: false };
    await page.waitForTimeout(2500);
  }

  // Nudge the switcher open — its menu is where the token most reliably lives,
  // and on some pages it is not rendered until first interaction.
  const switcher = page.locator([
    '#sc-mkt-picker-switcher-select',
    '[data-testid*="marketplace" i]',
    '[id*="picker" i]',
    'button:has-text("Amazon.")',
  ].join(', ')).first();

  if (await switcher.count().catch(() => 0)) {
    await switcher.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
    last = await gather(page);
    const candidates = extractMerchantIds(last.text, last.cookies);
    if (candidates.length) return { host, candidates, signedOut: false };
  }

  return { host, candidates: [], signedOut: looksSignedOut(last.text) };
}
