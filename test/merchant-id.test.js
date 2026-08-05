import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMerchantIds, looksLikeToken, isPlaceholder, looksSignedOut,
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
