import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMerchantIds, looksLikeToken, isPlaceholder, looksSignedOut, isMarketplaceId,
  parseSwitchUrl, looksLikePaid,
} from '../src/merchant-id.js';

const REAL = 'A2K8LM3PQ9WXYZ';
const OTHER = 'A3JQ7WD2LMN4XY';

test('recognises the shape of a merchant token', () => {
  assert.equal(looksLikeToken(REAL), true);
  assert.equal(looksLikeToken('ATVPDKIKX0DER'), true, 'shape alone cannot rule out a marketplace id');
  assert.equal(looksLikeToken('short'), false);
  assert.equal(looksLikeToken('a2k8lm3pq9wxyz'), false, 'lowercase is not a token');
  assert.equal(looksLikeToken(''), false);
  assert.equal(looksLikeToken(undefined), false);
});

test('spots the placeholder from the setup instructions', () => {
  assert.equal(isPlaceholder('A1XXXXXXXXXXXX'), true);
  assert.equal(isPlaceholder('A2XXXXXXXXXXXX'), true);
  assert.equal(isPlaceholder(REAL), false);
});

test('pulls the token out of a marketplace-switcher link', () => {
  const html = `<a href="/home?mons_sel_dir_mcid=${REAL}&mons_sel_mkid=amzn1.mp.o.A2EUQ1WTGCTBG2">Canada</a>`;
  const [top] = extractMerchantIds(html);
  assert.equal(top.token, REAL);
  assert.ok(top.sources.includes('marketplace-switcher link'));
});

test('never mistakes a marketplace id for a merchant token', () => {
  // Every marketplace id in the config has the same shape as a merchant token,
  // and they appear all over the switcher markup.
  const html = `
    <a href="/home?mons_sel_mkid=amzn1.mp.o.ATVPDKIKX0DER">US</a>
    <a href="/home?mons_sel_mkid=amzn1.mp.o.A1F83G8C2ARO7P">UK</a>
    <script>{"merchantId":"${REAL}"}</script>`;
  const found = extractMerchantIds(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].token, REAL);
  for (const id of ['ATVPDKIKX0DER', 'A1F83G8C2ARO7P', 'A1PA6795UKMFR9']) {
    assert.ok(!found.some((c) => c.token === id), `${id} is a marketplace id, not a merchant`);
  }
});

test('ranks the token corroborated by more sources first', () => {
  const html = `
    <a href="/x?mons_sel_dir_mcid=${REAL}">a</a>
    <script>{"merchantId":"${REAL}","sellerId":"${REAL}"}</script>
    <script>{"merchantCustomerId":"${OTHER}"}</script>`;
  const found = extractMerchantIds(html);
  assert.equal(found[0].token, REAL);
  assert.equal(found[0].sources.length, 3);
  assert.equal(found[1].token, OTHER);
});

test('reads a token out of cookies when the HTML has none', () => {
  const cookies = [
    { name: 'ld_mcid', value: REAL },
    { name: 'session-id', value: '123-4567890-1234567' },
  ];
  const [top] = extractMerchantIds('<html></html>', cookies);
  assert.equal(top.token, REAL);
  assert.match(top.sources[0], /cookie/);
});

test('irrelevant cookies do not contribute candidates', () => {
  const cookies = [{ name: 'session-token', value: 'AAAAAAAAAAAAAAAA' }];
  assert.deepEqual(extractMerchantIds('', cookies), []);
});

test('a page with nothing to find returns nothing rather than guessing', () => {
  assert.deepEqual(extractMerchantIds('<html><body>Signed out</body></html>'), []);
  assert.deepEqual(extractMerchantIds(''), []);
  assert.deepEqual(extractMerchantIds(null), []);
});

test('handles the real-world case of the token appearing many times', () => {
  const html = Array.from({ length: 12 },
    (_, i) => `<a href="/r?mons_sel_dir_mcid=${REAL}&i=${i}">m${i}</a>`).join('');
  const found = extractMerchantIds(html);
  assert.equal(found.length, 1, 'repeats collapse to one candidate');
  assert.equal(found[0].sources.length, 1, 'one source, not twelve');
});

test('tells a signed-out page apart from a signed-in one with no token', () => {
  assert.equal(looksSignedOut('<title>Amazon Sign-In</title><form action="/ap/signin">'), true);
  assert.equal(looksSignedOut('<html><body>Seller Central Home</body></html>'), false);
  assert.equal(
    looksSignedOut('<a href="/ap/signin">Sign in</a><a href="?mons_sel_dir_mcid=A2K8LM3PQ9WXYZ">'),
    false,
    'a token present means signed in, whatever else the page mentions');
});

test('finds tokens in the newer markup shapes', () => {
  for (const [label, html] of [
    ['merchantToken', `{"merchantToken":"${REAL}"}`],
    ['data attribute', `<div data-merchant-id="${REAL}"></div>`],
    ['sellerId param', `<a href="/x?sellerId=${REAL}">x</a>`],
    ['path segment', `<a href="/merchant/${REAL}/settings">x</a>`],
    ['encodedMerchantId', `{"encodedMerchantId":"${REAL}"}`],
  ]) {
    const [top] = extractMerchantIds(html);
    assert.ok(top, `nothing found for ${label}`);
    assert.equal(top.token, REAL, label);
  }
});

const MODERN_ID = 'amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS';

test('accepts both the modern and legacy merchant id shapes', () => {
  assert.equal(looksLikeToken(MODERN_ID), true);
  assert.equal(looksLikeToken(REAL), true);
  assert.equal(looksLikeToken('amzn1.merchant.d.'), false, 'prefix alone is not an id');
  assert.equal(looksLikeToken('amzn1.mp.o.ATVPDKIKX0DER'), false, 'that is a marketplace id');
});

test('a modern id is never truncated to a legacy-shaped fragment', () => {
  // The bug this guards: A[A-Z0-9]{11,19} matches the first 20 characters of
  // EXAMPLEMERCHANTIDFORTESTS, producing a wrong id of the right shape.
  const [top] = extractMerchantIds(`<a href="/x?mons_sel_dir_mcid=${MODERN_ID}">m</a>`);
  assert.equal(top.token, MODERN_ID);
  assert.ok(top.token.length > 20, 'must not be truncated to a legacy-length fragment');
});

test('marketplace ids are rejected however they are written', () => {
  assert.equal(isMarketplaceId('amzn1.mp.o.ATVPDKIKX0DER'), true);
  assert.equal(isMarketplaceId('ATVPDKIKX0DER'), true, 'bare marketplace id too');
  assert.equal(isMarketplaceId('amzn1.mp.o.A1F83G8C2ARO7P'), true);
  assert.equal(isMarketplaceId(MODERN_ID), false);
  assert.equal(isMarketplaceId(REAL), false);
});

test('a real switcher URL yields the merchant, not the marketplace beside it', () => {
  const html = `<a href="/home?mons_sel_dir_mcid=${MODERN_ID}`
    + '&mons_sel_mkid=amzn1.mp.o.A1PA6795UKMFR9">Germany</a>';
  const found = extractMerchantIds(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].token, MODERN_ID);
});

test('modern ids survive being read out of a cookie', () => {
  const [top] = extractMerchantIds('', [{ name: 'ld_mcid', value: MODERN_ID }]);
  assert.equal(top.token, MODERN_ID, 'splitting on dots would have shredded this');
});

const SWITCH_URL = 'https://sellercentral.amazon.com/amazonsell/business'
  + '?mons_sel_mkid=amzn1.mp.o.A2EUQ1WTGCTBG2'
  + '&mons_sel_dir_mcid=amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS'
  + '&mons_sel_dir_paid=amzn1.pa.d.EXAMPLEPAIDIDFORTESTS'
  + '&ignore_selection_changed=true';

test('a pasted switch URL yields all three ids, unconfused', () => {
  const p = parseSwitchUrl(SWITCH_URL);
  assert.equal(p.mcid, 'amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS');
  assert.equal(p.mkid, 'amzn1.mp.o.A2EUQ1WTGCTBG2');
  assert.equal(p.paid, 'amzn1.pa.d.EXAMPLEPAIDIDFORTESTS');
  assert.equal(p.host, 'sellercentral.amazon.com');
});

test('parseSwitchUrl declines anything that is not a URL', () => {
  assert.equal(parseSwitchUrl('amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS'), null);
  assert.equal(parseSwitchUrl(''), null);
  assert.equal(parseSwitchUrl(undefined), null);
  assert.equal(parseSwitchUrl('sellercentral.amazon.com?x=1'), null, 'needs a scheme');
});

test('a URL without the merchant parameter reports it rather than guessing', () => {
  const p = parseSwitchUrl('https://sellercentral.amazon.com/home?mons_sel_mkid=amzn1.mp.o.ATVPDKIKX0DER');
  assert.equal(p.mcid, null);
  assert.equal(p.mkid, 'amzn1.mp.o.ATVPDKIKX0DER');
});

test('the host tells NA and EU URLs apart', () => {
  const eu = /amazon\.(co\.uk|de|fr|it|es)$/;
  assert.equal(eu.test(parseSwitchUrl(SWITCH_URL).host), false);
  assert.equal(eu.test(parseSwitchUrl(
    'https://sellercentral.amazon.co.uk/x?mons_sel_dir_mcid=amzn1.merchant.d.AAAAAAAAAAAA').host), true);
  assert.equal(eu.test(parseSwitchUrl(
    'https://sellercentral.amazon.de/x?mons_sel_dir_mcid=amzn1.merchant.d.AAAAAAAAAAAA').host), true);
});

test('recognises the paid id shape', () => {
  assert.equal(looksLikePaid('amzn1.pa.d.EXAMPLEPAIDIDFORTESTS'), true);
  assert.equal(looksLikePaid('amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS'), false);
  assert.equal(looksLikePaid('amzn1.mp.o.ATVPDKIKX0DER'), false);
});
