import { validateSchema } from './guard.js';
import { planMapping, mapRows, CHILD_ASIN_INDEX, UNITS_ORDERED_INDEX, SALES_COLUMNS } from './sales-layout.js';
import { INVENTORY_PULLS, SALES_TABS, WINDOWS } from './config.js';
import { columnLetter } from './guard.js';

const MAX_COLUMNS = 52; // A..AZ, the range we clear

/**
 * Validate every fetched report, then assemble the tab payloads.
 *
 * Validation and assembly are one pass on purpose: a sales report can pass the
 * header guard and still be unusable if the two contractual columns can't be
 * located, and both problems should surface in the same report rather than one
 * after the other.
 */
export function validateAndAssemble(results) {
  const failures = [];
  const notes = [];

  for (const r of results) {
    const label = r.kind === 'inventory'
      ? `${r.code} inventory`
      : `${r.code} sales ${r.days}d`;

    try {
      validateSchema({ kind: r.kind, mp: r.mp, header: r.header, label });
    } catch (err) {
      failures.push({ label, error: err });
      continue;
    }

    if (r.kind === 'sales') {
      const { plan, missing } = planMapping(r.header);
      const critical = [
        [CHILD_ASIN_INDEX, SALES_COLUMNS[CHILD_ASIN_INDEX].name],
        [UNITS_ORDERED_INDEX, SALES_COLUMNS[UNITS_ORDERED_INDEX].name],
      ].filter(([i]) => plan[i] === -1);

      if (critical.length) {
        failures.push({
          label,
          error: new Error(
            `cannot locate ${critical.map(([i, n]) => `"${n}" (output column ${columnLetter(i + 1)})`).join(' or ')} `
            + `in the downloaded report. Columns present: ${r.header.join(', ')}`),
        });
        continue;
      }

      if (missing.length) {
        notes.push(`${label}: ${missing.length} padding column(s) left blank `
          + `(${missing.join(', ')}) — B and N are correct, so downstream SUMIFs are unaffected`);
      }
      r.mapped = mapRows(r.rows, plan);
    }

    if (r.header.length > MAX_COLUMNS) {
      failures.push({
        label,
        error: new Error(`report has ${r.header.length} columns, beyond the A:AZ range `
          + 'this bot clears. Widen MAX_COLUMNS and the clear range together.'),
      });
    }
  }

  if (failures.length) return { ok: false, failures, notes, tabs: [] };

  const tabs = [];

  for (const { marketplace: code, tab } of INVENTORY_PULLS) {
    const r = results.find((x) => x.kind === 'inventory' && x.code === code);
    if (!r) {
      failures.push({ label: tab, error: new Error('no inventory result was fetched') });
      continue;
    }
    // Written exactly as Amazon emits it. NA is 24 columns, EU is 26, and
    // Calc_Data reads by letter — normalising the two into one shape would
    // move afn-fc-transfer-quantity and break every European DOI figure.
    tabs.push({ tab, rows: r.rows, sources: [`${code} (${r.header.length} cols)`] });
  }

  for (const { tab: prefix, marketplaces } of SALES_TABS) {
    for (const days of WINDOWS) {
      const tab = `${prefix} ${days}`;
      const parts = marketplaces.map((code) =>
        results.find((x) => x.kind === 'sales' && x.code === code && x.days === days));

      if (parts.some((p) => !p)) {
        failures.push({ label: tab, error: new Error('missing one of its marketplace pulls') });
        continue;
      }
      tabs.push({
        tab,
        rows: parts.flatMap((p) => p.mapped),
        sources: parts.map((p) => `${p.code}=${p.mapped.length}`),
      });
    }
  }

  if (failures.length) return { ok: false, failures, notes, tabs: [] };
  return { ok: true, failures, notes, tabs };
}
