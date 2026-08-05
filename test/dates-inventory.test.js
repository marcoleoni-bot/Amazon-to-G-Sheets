import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRowDate } from '../src/fetch-inventory.js';

/**
 * Report Central row timestamps. Reading these wrong makes a fresh report look
 * stale, so the bot waits for one that already exists.
 */

test('North American rows are month-first', () => {
  const d = parseRowDate('FBA Inventory 08/05/2026 10:30 AM Download', false);
  assert.equal(d.toISOString().slice(0, 10), '2026-08-05');
});

test('European rows are day-first', () => {
  const d = parseRowDate('FBA Lagerbestand 05.08.2026 10:30 Herunterladen', true);
  assert.equal(d.toISOString().slice(0, 10), '2026-08-05');
});

test('the same string means different days in each region', () => {
  const text = 'report 05/08/2026';
  assert.equal(parseRowDate(text, false).toISOString().slice(0, 10), '2026-05-08');
  assert.equal(parseRowDate(text, true).toISOString().slice(0, 10), '2026-08-05');
});

test('an impossible month is corrected rather than dropped', () => {
  // 25/12/2026 cannot be month-first however the page intends it.
  const d = parseRowDate('report 25/12/2026', false);
  assert.equal(d.toISOString().slice(0, 10), '2026-12-25');
});

test('ISO timestamps win outright', () => {
  const d = parseRowDate('generated 2026-08-05T09:15 ready', false);
  assert.equal(d.toISOString().slice(0, 16), '2026-08-05T09:15');
});

test('PM is twelve hours later, and 12 AM is midnight', () => {
  assert.equal(parseRowDate('08/05/2026 01:30 PM').toISOString().slice(11, 16), '13:30');
  assert.equal(parseRowDate('08/05/2026 12:15 AM').toISOString().slice(11, 16), '00:15');
});

test('a row with no date yields null, not a wrong date', () => {
  assert.equal(parseRowDate('FBA Inventory Download'), null);
  assert.equal(parseRowDate(''), null);
});

test('a fresh report is never mistaken for a stale one', () => {
  // The failure this guards: a report generated today read as three months old
  // and rejected, while the poller waits for one that already exists.
  const today = new Date();
  const dd = String(today.getUTCDate()).padStart(2, '0');
  const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = today.getUTCFullYear();

  const na = parseRowDate(`${mm}/${dd}/${yyyy} 08:00 AM`, false);
  const eu = parseRowDate(`${dd}/${mm}/${yyyy} 08:00`, true);
  for (const [label, d] of [['NA', na], ['EU', eu]]) {
    const ageHours = (Date.now() - d.getTime()) / 3_600_000;
    assert.ok(ageHours < 26, `${label} report today read as ${ageHours.toFixed(0)}h old`);
  }
});
