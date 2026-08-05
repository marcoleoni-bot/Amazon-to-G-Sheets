import { SchemaChangedError, NotRecordedError } from './errors.js';
import { loadSchema, schemaKey } from './schema-store.js';

/**
 * The schema guard.
 *
 * Calc_Data reads these tabs by column *letter*. A column appended, removed, or
 * reordered upstream does not error anywhere — the QUERY simply starts reading
 * the neighbouring column and returns numbers that look entirely plausible.
 * That failure is invisible for months, which is exactly how
 * afn-fc-transfer-quantity went missing from Openbridge's table.
 *
 * So nothing gets written until its header row matches the stored baseline
 * exactly: same names, same order, same count.
 */

/** 1 → A, 26 → Z, 27 → AA. Positions are 1-based to match the spreadsheet. */
export function columnLetter(pos) {
  let n = pos;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const at = (pos) => `${pos}/${columnLetter(pos)}`;

/**
 * Compare an actual header against the expected one.
 * Returns { ok, report, mismatches, added, removed, moved }.
 */
export function diffHeader(expected, actual) {
  const mismatches = [];
  const max = Math.max(expected.length, actual.length);

  for (let i = 0; i < max; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e !== a) {
      mismatches.push({
        position: i + 1,
        letter: columnLetter(i + 1),
        expected: e ?? '(nothing — report is wider than the baseline)',
        actual: a ?? '(nothing — report is narrower than the baseline)',
      });
    }
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const added = actual.filter((c) => !expectedSet.has(c))
    .map((c) => ({ name: c, position: actual.indexOf(c) + 1 }));
  const removed = expected.filter((c) => !actualSet.has(c))
    .map((c) => ({ name: c, position: expected.indexOf(c) + 1 }));
  const moved = expected
    .map((c, i) => ({ name: c, from: i + 1, to: actual.indexOf(c) + 1 }))
    .filter((m) => m.to > 0 && m.to !== m.from);

  const ok = mismatches.length === 0;

  const lines = [];
  if (!ok) {
    lines.push(`  baseline has ${expected.length} columns, report has ${actual.length}`);
    lines.push('');
    for (const m of mismatches) {
      lines.push(`  position ${at(m.position).padEnd(6)} expected "${m.expected}"`);
      lines.push(`  ${' '.repeat(20)}actual   "${m.actual}"`);
    }
    if (added.length) {
      lines.push('');
      lines.push(`  added:   ${added.map((c) => `"${c.name}" at ${at(c.position)}`).join(', ')}`);
    }
    if (removed.length) {
      lines.push(`  removed: ${removed.map((c) => `"${c.name}" was at ${at(c.position)}`).join(', ')}`);
    }
    if (moved.length) {
      lines.push(`  moved:   ${moved.map((m) => `"${m.name}" ${at(m.from)} → ${at(m.to)}`).join(', ')}`);
    }
  }

  return { ok, mismatches, added, removed, moved, report: lines.join('\n') };
}

/**
 * Validate a parsed report against its stored baseline. Throws on any change.
 *
 * A *provisional* baseline is one that was written from a layout nobody has
 * eyeballed against a real download yet. It still blocks the write — but the
 * message says "confirm this" rather than "Amazon changed something", because
 * on a provisional baseline the first mismatch is far more likely to be our
 * guess being wrong than Amazon moving a column.
 */
export function validateSchema({ kind, mp, header, label }) {
  const key = schemaKey(kind, mp);
  const baseline = loadSchema(key);

  if (!baseline) {
    throw new NotRecordedError(
      `No schema baseline for "${key}"`,
      `  Download one ${kind} report, check the columns are what you expect, then:\n`
      + `    npm run baseline -- ${kind} ${mp.code}`);
  }

  const diff = diffHeader(baseline.columns, header);
  if (diff.ok) return { key, baseline, diff };

  const preamble = baseline.provisional
    ? `  The "${key}" baseline is PROVISIONAL — it was written from a documented\n`
      + '  layout, not from a verified download. A mismatch here most likely means the\n'
      + '  baseline is wrong, not Amazon. Check the columns below against the real file;\n'
      + `  if the report is correct, accept it with:  npm run baseline -- ${kind} ${mp.code}\n\n`
    : '';

  throw new SchemaChangedError(label, { ...diff, report: preamble + diff.report });
}
