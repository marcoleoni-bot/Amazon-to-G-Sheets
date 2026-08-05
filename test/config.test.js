import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Merchant ID resolution: environment variable, then the recorded cache, with
 * the setup placeholder treated as a leftover rather than as configuration.
 */
const CACHE = join(mkdtempSync(join(tmpdir(), 'arb-cfg-')), 'merchants.json');
writeFileSync(CACHE, JSON.stringify({
  NA: 'amzn1.merchant.d.NAMERCHANTFROMCACHE',
  EU: 'amzn1.merchant.d.EUMERCHANTFROMCACHE',
  paid: 'amzn1.pa.d.PAIDFROMCACHE',
}));
process.env.MERCHANT_CACHE = CACHE;

const { merchantId, paidId } = await import('../src/config.js');
const { withMarketplace } = await import('../src/browser.js');
const { marketplace } = await import('../src/config.js');

const clearEnv = () => {
  delete process.env.NA_MERCHANT_ID;
  delete process.env.EU_MERCHANT_ID;
  delete process.env.AMZN_PAID_ID;
};

test('falls back to the recorded cache when no variable is set', () => {
  clearEnv();
  assert.equal(merchantId('US'), 'amzn1.merchant.d.NAMERCHANTFROMCACHE');
  assert.equal(merchantId('CA'), 'amzn1.merchant.d.NAMERCHANTFROMCACHE', 'US and CA share NA');
  assert.equal(merchantId('DE'), 'amzn1.merchant.d.EUMERCHANTFROMCACHE');
  assert.equal(merchantId('ES'), 'amzn1.merchant.d.EUMERCHANTFROMCACHE', 'all of EU shares one');
});

test('a real environment variable wins over the cache', () => {
  clearEnv();
  process.env.NA_MERCHANT_ID = 'amzn1.merchant.d.FROMENVIRONMENT';
  assert.equal(merchantId('US'), 'amzn1.merchant.d.FROMENVIRONMENT');
  clearEnv();
});

test('a leftover placeholder does not beat a recorded ID', () => {
  // The dead-end this fixes: a placeholder left in ~/.zshrc used to override a
  // perfectly good recorded value and fail the run.
  clearEnv();
  process.env.NA_MERCHANT_ID = 'A1XXXXXXXXXXXX';
  assert.equal(merchantId('US'), 'amzn1.merchant.d.NAMERCHANTFROMCACHE');
  clearEnv();
});

test('the paid id is shared by both regions', () => {
  clearEnv();
  assert.equal(paidId(), 'amzn1.pa.d.PAIDFROMCACHE');
});

test('switch URLs carry merchant, marketplace and paid, each in its own parameter', () => {
  clearEnv();
  const url = new URL(withMarketplace(marketplace('DE'), '/reportcentral/X/1'));
  assert.equal(url.searchParams.get('mons_sel_dir_mcid'), 'amzn1.merchant.d.EUMERCHANTFROMCACHE');
  assert.equal(url.searchParams.get('mons_sel_mkid'), 'amzn1.mp.o.A1PA6795UKMFR9');
  assert.equal(url.searchParams.get('mons_sel_dir_paid'), 'amzn1.pa.d.PAIDFROMCACHE');
  assert.equal(url.searchParams.get('ignore_selection_changed'), 'true');
});

test('every marketplace is reached on its region host, not its own domain', () => {
  // Session cookies are per-domain. sellercentral.amazon.de redirects a
  // .co.uk session straight to /ap/signin, which is indistinguishable from an
  // expired session — so the marketplace is chosen by parameter, not by host.
  clearEnv();
  for (const code of ['UK', 'DE', 'FR', 'IT', 'ES']) {
    assert.equal(new URL(withMarketplace(marketplace(code), '/x')).host,
      'sellercentral.amazon.co.uk', `${code} must stay on the EU host`);
  }
  for (const code of ['US', 'CA']) {
    assert.equal(new URL(withMarketplace(marketplace(code), '/x')).host,
      'sellercentral.amazon.com', `${code} must stay on the NA host`);
  }
});

test('every marketplace id keeps the amzn1.mp.o. prefix', () => {
  clearEnv();
  for (const code of ['US', 'CA', 'UK', 'DE', 'FR', 'IT', 'ES']) {
    const url = new URL(withMarketplace(marketplace(code), '/x'));
    assert.match(url.searchParams.get('mons_sel_mkid'), /^amzn1\.mp\.o\./,
      `${code} would silently no-op without the prefix`);
  }
});

const { marketplaceFromLabel } = await import('../src/browser.js');

test('the marketplace picker label identifies the marketplace', () => {
  assert.equal(marketplaceFromLabel('United Kingdom').code, 'UK');
  assert.equal(marketplaceFromLabel('Germany').code, 'DE');
  assert.equal(marketplaceFromLabel('Deutschland').code, 'DE');
  assert.equal(marketplaceFromLabel('Amazon.co.uk').code, 'UK');
  assert.equal(marketplaceFromLabel('España').code, 'ES');
  assert.equal(marketplaceFromLabel('Italia').code, 'IT');
});

test('the picker is the only way to tell DE, FR, IT and ES apart', () => {
  // They share the "-EU" SKU suffix, so the downloaded file cannot distinguish
  // them. If this ever stops working, those four lose their only real check.
  const seen = new Set();
  for (const [label, code] of [['Germany', 'DE'], ['France', 'FR'],
    ['Italy', 'IT'], ['Spain', 'ES']]) {
    const hit = marketplaceFromLabel(label);
    assert.equal(hit.code, code);
    seen.add(hit.code);
  }
  assert.equal(seen.size, 4, 'all four must be distinguishable by label');
});

test('an unrecognised label names nothing rather than guessing', () => {
  assert.equal(marketplaceFromLabel('Seller Central'), null);
  assert.equal(marketplaceFromLabel(''), null);
  assert.equal(marketplaceFromLabel(undefined), null);
});
