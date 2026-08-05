import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exercises the phase-2 logic `npm start` depends on, with fabricated report
 * payloads — the shape of a run, without Amazon.
 *
 * These tests need a sales baseline, and no real one exists yet (nobody has
 * downloaded the report). Rather than commit a fabricated one, the schema
 * directory is redirected to a temp copy for the duration of this file.
 */
const REAL_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const TMP_SCHEMAS = mkdtempSync(join(tmpdir(), 'arb-schemas-'));
for (const f of readdirSync(REAL_SCHEMAS)) {
  copyFileSync(join(REAL_SCHEMAS, f), join(TMP_SCHEMAS, f));
}
process.env.SCHEMA_DIR = TMP_SCHEMAS;

const { validateAndAssemble } = await import('../src/assemble.js');
const { saveSchema, loadSchema } = await import('../src/schema-store.js');
const { MARKETPLACES, INVENTORY_PULLS, SALES_PULLS } = await import('../src/config.js');

const NA_HEADER = loadSchema('inventory.NA').columns;
const EU_HEADER = loadSchema('inventory.EU').columns;

const SALES_SOURCE = [
  '(Parent) ASIN', '(Child) ASIN', 'Title', 'SKU',
  'Sessions - Mobile App', 'Sessions - Browser', 'Sessions - Total',
  'Session Percentage - Total',
  'Page Views - Mobile App', 'Page Views - Browser', 'Page Views - Total',
  'Page Views Percentage - Total',
  'Featured Offer (Buy Box) Percentage', 'Units Ordered',
  'Unit Session Percentage', 'Ordered Product Sales', 'Total Order Items',
];

// The sales baseline is deliberately not shipped (nobody has seen the real
// header yet), so record one for the duration of this file.
if (!loadSchema('sales')) {
  saveSchema('sales', SALES_SOURCE, { provisional: true, note: 'written by the test suite' });
}

const invResult = (code) => {
  const mp = MARKETPLACES[code];
  const header = mp.region === 'NA' ? NA_HEADER : EU_HEADER;
  const suffix = mp.skuSuffix || '';
  return {
    kind: 'inventory',
    code,
    mp,
    header,
    rows: [1, 2].map((n) => header.map((_, i) => (i === 0 ? `SKU${n}${suffix}` : `${i}`))),
    marketplaceCheck: { checked: true },
  };
};

const salesResult = (code, days, rowCount = 2) => ({
  kind: 'sales',
  code,
  days,
  mp: MARKETPLACES[code],
  header: SALES_SOURCE,
  rows: Array.from({ length: rowCount }, (_, n) =>
    SALES_SOURCE.map((_, i) => {
      if (i === 1) return `${code}-ASIN-${n}`;
      if (i === 13) return String(n + 1);
      return `x${i}`;
    })),
  marketplaceCheck: { checked: true },
});

const fullRun = () => [
  ...INVENTORY_PULLS.map((p) => invResult(p.marketplace)),
  ...SALES_PULLS.map((p) => salesResult(p.marketplace, p.days)),
];

test('a clean run assembles all 16 tabs', () => {
  const { ok, tabs, failures } = validateAndAssemble(fullRun());
  assert.deepEqual(failures, []);
  assert.equal(ok, true);
  assert.equal(tabs.length, 16);

  const names = tabs.map((t) => t.tab);
  for (const expected of ['US Inventory', 'CA Inventory', 'UK Inventory', 'DE Inventory',
    'US Sales 7', 'CA Sales 30', 'UK Sales 90', 'DE Sales 7']) {
    assert.ok(names.includes(expected), `missing tab ${expected}`);
  }
});

test('inventory tabs keep their per-region column count', () => {
  const { tabs } = validateAndAssemble(fullRun());
  assert.equal(tabs.find((t) => t.tab === 'US Inventory').rows[0].length, 24);
  assert.equal(tabs.find((t) => t.tab === 'UK Inventory').rows[0].length, 26);
  assert.equal(tabs.find((t) => t.tab === 'DE Inventory').rows[0].length, 26);
});

test('the DE sales tab is DE + FR + IT + ES appended in order', () => {
  const results = fullRun();
  const de = validateAndAssemble(results).tabs.find((t) => t.tab === 'DE Sales 30');
  assert.equal(de.rows.length, 8); // 4 marketplaces x 2 rows
  assert.deepEqual(de.sources, ['DE=2', 'FR=2', 'IT=2', 'ES=2']);
  assert.equal(de.rows[0][1], 'DE-ASIN-0');
  assert.equal(de.rows[2][1], 'FR-ASIN-0');
  assert.equal(de.rows[4][1], 'IT-ASIN-0');
  assert.equal(de.rows[6][1], 'ES-ASIN-0');
});

test('every sales row carries ASIN in B and units in N', () => {
  const { tabs } = validateAndAssemble(fullRun());
  for (const tab of tabs.filter((t) => t.tab.includes('Sales'))) {
    for (const row of tab.rows) {
      assert.match(row[1], /-ASIN-\d$/, `${tab.tab}: column B`);
      assert.match(row[13], /^\d+$/, `${tab.tab}: column N`);
      assert.equal(row.length, 17);
    }
  }
});

test('one changed column blocks the whole run, not just its own tab', () => {
  const results = fullRun();
  const us = results.find((r) => r.kind === 'inventory' && r.code === 'US');
  us.header = [...NA_HEADER, 'afn-brand-new-column'];

  const { ok, tabs, failures } = validateAndAssemble(results);
  assert.equal(ok, false);
  assert.deepEqual(tabs, [], 'nothing may be assembled when any report fails');
  assert.equal(failures.length, 1);
  assert.match(failures[0].error.message, /afn-brand-new-column/);
  assert.match(failures[0].error.message, /25\/Y/);
});

test('a missing Units Ordered column fails with the output position named', () => {
  const results = fullRun();
  const de = results.find((r) => r.kind === 'sales' && r.code === 'DE' && r.days === 7);
  de.header = SALES_SOURCE.filter((h) => h !== 'Units Ordered');
  saveSchema('sales', de.header, { provisional: true, note: 'test' });

  const { ok, failures } = validateAndAssemble([de]);
  assert.equal(ok, false);
  assert.match(failures[0].error.message, /Units Ordered.*column N/s);

  saveSchema('sales', SALES_SOURCE, { provisional: true, note: 'test' });
});

test('an incomplete DE group fails rather than writing a short tab', () => {
  const results = fullRun().filter((r) => !(r.kind === 'sales' && r.code === 'IT' && r.days === 90));
  const { ok, failures } = validateAndAssemble(results);
  assert.equal(ok, false);
  assert.ok(failures.some((f) => f.label === 'DE Sales 90'));
});
