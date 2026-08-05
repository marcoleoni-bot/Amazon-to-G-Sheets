/**
 * Sales output layout.
 *
 * Calc_Data reads the sales tabs positionally — SUMIF over column B keyed on
 * child ASIN, summing column N. Those two positions are contractual:
 *
 *     column B (index 1)  = (Child) ASIN
 *     column N (index 13) = Units Ordered
 *
 * Everything else in between is padding that keeps those two where they are.
 * So unlike the inventory tabs — which are written byte-for-byte as Amazon
 * emits them — sales rows are rebuilt by *name* into fixed positions. If Amazon
 * reorders its export, the guard still fails loudly (that is the whole point of
 * the guard), but the rebuilt output would have stayed correct anyway.
 */

export const CHILD_ASIN_INDEX = 1;   // B
export const UNITS_ORDERED_INDEX = 13; // N

/**
 * `from` lists the source header names that may supply this column, best first.
 * Matching is done on a normalised form, so "Sessions – Total" (en dash),
 * "Sessions - Total" (hyphen) and "Sessions  Total" all match the same entry.
 */
export const SALES_COLUMNS = [
  { name: '(Parent) ASIN', from: ['(Parent) ASIN', 'Parent ASIN'] },
  { name: '(Child) ASIN', from: ['(Child) ASIN', 'Child ASIN', 'ASIN'] },
  { name: 'Title', from: ['Title', 'Product Name'] },
  { name: 'SKU', from: ['SKU', 'seller-sku'] },
  { name: 'Sessions - Mobile App', from: ['Sessions - Mobile App'] },
  { name: 'Sessions - Browser', from: ['Sessions - Browser'] },
  { name: 'Sessions - Total', from: ['Sessions - Total', 'Sessions'] },
  { name: 'Session Percentage - Total', from: ['Session Percentage - Total', 'Session Percentage'] },
  { name: 'Page Views - Mobile App', from: ['Page Views - Mobile App'] },
  { name: 'Page Views - Browser', from: ['Page Views - Browser'] },
  { name: 'Page Views - Total', from: ['Page Views - Total', 'Page Views'] },
  { name: 'Page Views Percentage - Total', from: ['Page Views Percentage - Total', 'Page Views Percentage'] },
  { name: 'Featured Offer (Buy Box) Percentage', from: ['Featured Offer (Buy Box) Percentage', 'Buy Box Percentage'] },
  { name: 'Units Ordered', from: ['Units Ordered'] },
  { name: 'Unit Session Percentage', from: ['Unit Session Percentage'] },
  { name: 'Ordered Product Sales', from: ['Ordered Product Sales'] },
  { name: 'Total Order Items', from: ['Total Order Items'] },
];

/** Fold dashes, punctuation and spacing so header variants compare equal. */
export function normalise(name) {
  return String(name || '')
    .replace(/[‐-―]/g, '-')  // en/em dashes → hyphen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Fail at import time rather than after 21 downloads if someone edits the list
// above and quietly breaks the two positions that matter.
(() => {
  const b = SALES_COLUMNS[CHILD_ASIN_INDEX];
  const n = SALES_COLUMNS[UNITS_ORDERED_INDEX];
  if (!b || normalise(b.name) !== normalise('(Child) ASIN')) {
    throw new Error(`sales-layout: column B must be (Child) ASIN, found "${b?.name}"`);
  }
  if (!n || normalise(n.name) !== normalise('Units Ordered')) {
    throw new Error(`sales-layout: column N must be Units Ordered, found "${n?.name}"`);
  }
})();

/**
 * Build a source-index lookup for each output column.
 * Returns { plan: number[], missing: string[] } where plan[i] is the source
 * column index feeding output column i, or -1 for "leave blank".
 */
export function planMapping(sourceHeader) {
  const index = new Map();
  sourceHeader.forEach((h, i) => {
    const key = normalise(h);
    if (!index.has(key)) index.set(key, i); // first wins; ignores B2B duplicates
  });

  const plan = [];
  const missing = [];
  for (const col of SALES_COLUMNS) {
    const hit = col.from.map((n) => index.get(normalise(n))).find((i) => i !== undefined);
    plan.push(hit ?? -1);
    if (hit === undefined) missing.push(col.name);
  }
  return { plan, missing };
}

/** Apply a mapping plan to source rows, producing fixed-position output rows. */
export function mapRows(rows, plan) {
  return rows.map((row) => plan.map((i) => (i === -1 ? '' : (row[i] ?? ''))));
}

export const SALES_OUTPUT_HEADER = SALES_COLUMNS.map((c) => c.name);
