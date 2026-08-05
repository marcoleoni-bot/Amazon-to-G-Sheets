import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReport, detectDelimiter, stripBom } from '../src/parse.js';
import { diffHeader, columnLetter } from '../src/guard.js';
import { verifyMarketplace, classifySku } from '../src/verify-marketplace.js';
import { planMapping, mapRows, SALES_COLUMNS } from '../src/sales-layout.js';
import { windowFor } from '../src/dates.js';
import { rowsFromJson } from '../src/fetch-sales.js';
import { loadSchema } from '../src/schema-store.js';
import { MarketplaceMismatchError, SchemaChangedError } from '../src/errors.js';

const NA_HEADER = loadSchema('inventory.NA').columns;
const EU_HEADER = loadSchema('inventory.EU').columns;

test('detects tab-separated despite commas in product names', () => {
  const tsv = 'sku\tasin\tproduct-name\nABC\tB001\tWidget, large, blue\n';
  assert.equal(detectDelimiter(tsv), '\t');
  const { header, rows, delimiter } = parseReport(Buffer.from(tsv));
  assert.equal(delimiter, 'tab');
  assert.deepEqual(header, ['sku', 'asin', 'product-name']);
  assert.equal(rows[0][2], 'Widget, large, blue');
});

test('detects quoted CSV', () => {
  const csv = 'sku,asin,product-name\n"ABC","B001","Widget, large"\n';
  const { header, rows, delimiter } = parseReport(Buffer.from(csv));
  assert.equal(delimiter, ',');
  assert.deepEqual(header, ['sku', 'asin', 'product-name']);
  assert.equal(rows[0][2], 'Widget, large');
});

test('strips the BOM so the first column name is clean', () => {
  const withBom = `﻿sku\tasin\nABC\tB001\n`;
  assert.equal(stripBom(withBom).startsWith('sku'), true);
  assert.equal(parseReport(Buffer.from(withBom, 'utf8')).header[0], 'sku');
});

test('survives a stray quote inside a field', () => {
  const tsv = 'sku\tproduct-name\nABC\t6" Widget "Pro"\n';
  const { rows } = parseReport(Buffer.from(tsv));
  assert.equal(rows.length, 1);
});

test('ragged rows do not abort the parse', () => {
  const tsv = 'a\tb\tc\n1\t2\t3\n4\t5\n';
  const { rows } = parseReport(Buffer.from(tsv));
  assert.equal(rows.length, 2);
});

test('column letters map to spreadsheet positions', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(22), 'V');   // afn-fc-transfer-quantity in NA
  assert.equal(columnLetter(24), 'X');   // ...and in EU
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
  assert.equal(columnLetter(52), 'AZ');
});

test('the NA/EU offset that motivates the guard is real', () => {
  assert.equal(NA_HEADER.indexOf('afn-fc-transfer-quantity') + 1, 22); // V
  assert.equal(EU_HEADER.indexOf('afn-fc-transfer-quantity') + 1, 24); // X
  assert.equal(NA_HEADER.length, 24);
  assert.equal(EU_HEADER.length, 26);
});

test('identical headers pass', () => {
  assert.equal(diffHeader(NA_HEADER, [...NA_HEADER]).ok, true);
});

test('an appended column is caught and located', () => {
  const actual = [...NA_HEADER, 'afn-new-thing'];
  const d = diffHeader(NA_HEADER, actual);
  assert.equal(d.ok, false);
  assert.equal(d.added[0].name, 'afn-new-thing');
  assert.equal(d.added[0].position, 25);
  assert.match(d.report, /25\/Y/);
});

test('a removed column reports where it used to be', () => {
  const actual = NA_HEADER.filter((c) => c !== 'afn-fc-transfer-quantity');
  const d = diffHeader(NA_HEADER, actual);
  assert.equal(d.ok, false);
  assert.equal(d.removed[0].name, 'afn-fc-transfer-quantity');
  assert.equal(d.removed[0].position, 22);
});

test('a reorder is caught even though the column set is unchanged', () => {
  const actual = [...NA_HEADER];
  [actual[10], actual[11]] = [actual[11], actual[10]];
  const d = diffHeader(NA_HEADER, actual);
  assert.equal(d.ok, false);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.moved.length, 2);
});

test('a rename shows expected vs actual at the position', () => {
  const actual = [...NA_HEADER];
  actual[5] = 'price';
  const d = diffHeader(NA_HEADER, actual);
  assert.equal(d.mismatches[0].position, 6);
  assert.equal(d.mismatches[0].expected, 'your-price');
  assert.equal(d.mismatches[0].actual, 'price');
});

test('EU report offered where NA is expected is caught', () => {
  const d = diffHeader(NA_HEADER, EU_HEADER);
  assert.equal(d.ok, false);
  assert.match(d.report, /afn-fulfillable-quantity-local/);
});

test('SKU suffixes classify to marketplaces', () => {
  assert.equal(classifySku('WIDGET-1-UK1'), 'UK');
  assert.equal(classifySku('WIDGET-1-CA'), 'CA');
  assert.equal(classifySku('WIDGET-1-EU'), 'EU-pool (DE/FR/IT/ES)');
  assert.equal(classifySku('WIDGET-1'), 'US (no suffix)');
});

const invRows = (skus) => skus.map((s) => [s, 'X00', 'B001', 'name']);
const invHeader = ['sku', 'fnsku', 'asin', 'product-name'];

test('a clean marketplace file passes', () => {
  const r = verifyMarketplace({
    code: 'UK', header: invHeader, rows: invRows(['A-UK1', 'B-UK1', 'C-UK1']),
  });
  assert.equal(r.checked, true);
  assert.equal(r.expectedCount, 3);
  assert.equal(r.foreignCount, 0);
});

test('contamination — the UK tab served the CA file — is caught', () => {
  assert.throws(
    () => verifyMarketplace({
      code: 'UK', header: invHeader, rows: invRows(['A-CA', 'B-CA', 'C-CA']),
    }),
    (err) => err instanceof MarketplaceMismatchError && /looks like|CA/.test(err.message));
});

test('US is verified by the absence of a suffix, not by ignoring the check', () => {
  assert.throws(
    () => verifyMarketplace({
      code: 'US', header: invHeader, rows: invRows(['A-EU', 'B-EU', 'C-EU']),
    }),
    MarketplaceMismatchError);
  assert.equal(
    verifyMarketplace({ code: 'US', header: invHeader, rows: invRows(['A', 'B', 'C']) }).checked,
    true);
});

test('a file carrying another marketplace\'s SKUs is rejected', () => {
  const skus = [...Array(6).fill('X-UK1'), ...Array(4).fill('Y-CA')];
  assert.throws(
    () => verifyMarketplace({ code: 'UK', header: invHeader, rows: invRows(skus) }),
    (err) => /another marketplace/.test(err.message));
});

test('DE passes on the EU pool but is flagged as block-level only', () => {
  const r = verifyMarketplace({
    code: 'DE', header: invHeader, rows: invRows(['A-EU', 'B-EU']),
  });
  assert.equal(r.checked, true);
  assert.equal(r.blockLevelOnly, true);
});

test('a report with no SKU column says so rather than passing silently', () => {
  const r = verifyMarketplace({ code: 'US', header: ['asin', 'title'], rows: [['B001', 'x']] });
  assert.equal(r.checked, false);
});

const SALES_SOURCE = [
  '(Parent) ASIN', '(Child) ASIN', 'Title', 'SKU',
  'Sessions – Mobile App', 'Sessions – Browser', 'Sessions – Total',
  'Session Percentage – Total',
  'Page Views – Mobile App', 'Page Views – Browser', 'Page Views – Total',
  'Page Views Percentage – Total',
  'Featured Offer (Buy Box) Percentage', 'Units Ordered',
  'Unit Session Percentage', 'Ordered Product Sales', 'Total Order Items',
];

test('sales rows land with ASIN in B and Units Ordered in N', () => {
  const { plan, missing } = planMapping(SALES_SOURCE);
  assert.deepEqual(missing, []);
  const row = SALES_SOURCE.map((_, i) => `v${i}`);
  row[1] = 'B0CHILD123';
  row[13] = '42';
  const [out] = mapRows([row], plan);
  assert.equal(out[1], 'B0CHILD123', 'column B must be the child ASIN');
  assert.equal(out[13], '42', 'column N must be Units Ordered');
});

test('a reordered source still lands in the contractual positions', () => {
  const shuffled = ['Units Ordered', '(Child) ASIN', 'Title', '(Parent) ASIN'];
  const { plan } = planMapping(shuffled);
  const [out] = mapRows([['7', 'B0XYZ', 'Thing', 'B0PARENT']], plan);
  assert.equal(out[1], 'B0XYZ');
  assert.equal(out[13], '7');
  assert.equal(out.length, SALES_COLUMNS.length);
});

test('en dash and hyphen header variants match the same column', () => {
  const withHyphens = SALES_SOURCE.map((h) => h.replace(/–/g, '-'));
  assert.deepEqual(planMapping(withHyphens).missing, []);
});

test('B2B columns do not hijack their non-B2B equivalents', () => {
  const src = ['(Parent) ASIN', '(Child) ASIN', 'Units Ordered - B2B', 'Units Ordered'];
  const { plan } = planMapping(src);
  const [out] = mapRows([['P', 'C', '1', '9']], plan);
  assert.equal(out[13], '9');
});

test('a legacy source missing the mobile/browser splits still yields B and N', () => {
  const legacy = ['(Parent) ASIN', '(Child) ASIN', 'Title', 'SKU', 'Sessions',
    'Session Percentage', 'Page Views', 'Page Views Percentage',
    'Buy Box Percentage', 'Units Ordered'];
  const { plan, missing } = planMapping(legacy);
  const [out] = mapRows([['P', 'C', 'T', 'S', '10', '1%', '20', '2%', '90%', '5']], plan);
  assert.equal(out[1], 'C');
  assert.equal(out[13], '5');
  assert.ok(missing.includes('Sessions - Mobile App'));
});

test('7-day window is inclusive of today', () => {
  const w = windowFor(7, new Date('2026-08-05T12:00:00Z'));
  assert.equal(w.end, '2026-08-05');
  assert.equal(w.start, '2026-07-30');
});

test('30 and 90 day windows', () => {
  assert.equal(windowFor(30, new Date('2026-08-05T00:00:00Z')).start, '2026-07-07');
  assert.equal(windowFor(90, new Date('2026-08-05T00:00:00Z')).start, '2026-05-08');
});

test('JSON responses are flattened into header + rows', () => {
  const payload = { data: { report: { rows: [
    { asin: 'B001', unitsOrdered: 3, sales: { amount: '10.00' } },
    { asin: 'B002', unitsOrdered: 5, sales: { amount: '20.00' } },
  ] } } };
  const { header, rows } = rowsFromJson(payload);
  assert.ok(header.includes('unitsOrdered'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0][header.indexOf('sales')], '10.00');
});

test('SchemaChangedError carries the diff, not just a message', () => {
  const d = diffHeader(NA_HEADER, [...NA_HEADER, 'extra']);
  const err = new SchemaChangedError('US inventory', d);
  assert.equal(err.diff.added[0].name, 'extra');
  assert.match(err.message, /US inventory/);
});

test('a contamination error names example SKUs, not just counts', () => {
  // Counts alone cannot distinguish "wrong file" from "our suffix convention
  // was recorded wrong". The SKUs themselves can.
  const header = ['sku', 'asin'];
  const rows = [['ABC-123', 'B1'], ['DEF-456', 'B2'], ['GHI-789', 'B3']];
  try {
    verifyMarketplace({ code: 'UK', header, rows });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /Example SKUs/);
    assert.match(err.message, /ABC-123/);
    assert.match(err.message, /not one of the .* carries the UK signal/);
  }
});

test('a mixed file reports examples from every class it saw', () => {
  const header = ['sku'];
  const rows = [...Array(6).fill(['X-UK1']), ...Array(4).fill(['Y-EU'])];
  try {
    verifyMarketplace({ code: 'UK', header, rows });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /X-UK1/);
    assert.match(err.message, /Y-EU/);
    assert.match(err.message, /another marketplace/);
  }
});

/**
 * Regression cases taken verbatim from real runs against the live account.
 * Each row count and distribution below was observed, not invented — three
 * files that must pass and two that must fail.
 */
const skuFile = (spec) => Object.entries(spec)
  .flatMap(([suffix, n]) => Array.from({ length: n },
    (_, i) => [`101-${1000 + i}-V2-COM${suffix === 'none' ? '' : suffix}`]));

test('real CA file: 65 suffixed + 74 legacy unsuffixed passes', () => {
  const r = verifyMarketplace({
    code: 'CA', header: ['sku'], rows: skuFile({ '-CA': 65, none: 74 }),
  });
  assert.equal(r.checked, true);
  assert.equal(r.expectedCount, 65);
  assert.equal(r.foreignCount, 0);
});

test('real UK file: 50 suffixed + 59 legacy unsuffixed passes', () => {
  const r = verifyMarketplace({
    code: 'UK', header: ['sku'], rows: skuFile({ '-UK1': 50, none: 59 }),
  });
  assert.equal(r.checked, true);
  assert.equal(r.expectedCount, 50);
});

test('real US file: 132 unsuffixed passes', () => {
  const r = verifyMarketplace({
    code: 'US', header: ['sku'], rows: skuFile({ none: 132 }),
  });
  assert.equal(r.checked, true);
  assert.equal(r.foreignCount, 0);
});

test('the US file served for a CA request is still caught', () => {
  // Observed before the marketplace-switch fix: 132 rows, not one of them -CA.
  assert.throws(
    () => verifyMarketplace({ code: 'CA', header: ['sku'], rows: skuFile({ none: 132 }) }),
    (err) => /not one of the 132 sampled SKUs carries the CA signal/.test(err.message));
});

test('the EU file served for a UK request is still caught', () => {
  // Observed before the fix: 61 unsuffixed, 55 -EU, zero -UK1.
  assert.throws(
    () => verifyMarketplace({ code: 'UK', header: ['sku'], rows: skuFile({ none: 61, '-EU': 55 }) }),
    (err) => /another marketplace/.test(err.message));
});

test('a handful of stray foreign SKUs is tolerated, a foreign file is not', () => {
  assert.doesNotThrow(() => verifyMarketplace({
    code: 'CA', header: ['sku'], rows: skuFile({ '-CA': 100, none: 95, '-UK1': 5 }),
  }), 'five strays in 200 rows is under tolerance');
  assert.throws(() => verifyMarketplace({
    code: 'CA', header: ['sku'], rows: skuFile({ '-CA': 100, none: 50, '-UK1': 50 }),
  }), MarketplaceMismatchError);
});
