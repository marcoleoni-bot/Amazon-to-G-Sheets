/**
 * Small pure helpers shared by the rule modules.
 *
 * Nothing here touches SpreadsheetApp, so the whole rule layer runs unchanged
 * under `npm test`.
 */

/** Sheet error literals that must not be read as data. */
var SHEET_ERRORS = ['#N/A', '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!',
  '#NULL!', '#ERROR!', 'No Rate', 'Loading...'];

function isSheetError(v) {
  return typeof v === 'string' && SHEET_ERRORS.indexOf(v.trim()) !== -1;
}

/**
 * A cell as a number. Blanks and sheet errors become `fallback` (0 by default)
 * rather than NaN, because a NaN silently poisons every comparison downstream.
 */
function num(v, fallback) {
  var d = (fallback === undefined) ? 0 : fallback;
  if (v === null || v === undefined || v === '') return d;
  if (typeof v === 'number') return isFinite(v) ? v : d;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isSheetError(v)) return d;
  var n = Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : d;
}

/** TRUE / "TRUE" / "YES" / "T" / 1 all mean true. */
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  var s = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === 'Y' || s === 'T' || s === '1';
}

/**
 * What kind of sheet this is.
 *
 * A Connected Sheet — one backed by BigQuery or another data source — refuses
 * most of the Range API with "The action is not supported for DATASOURCE
 * sheet." Reading a header off one, or scanning it for formulas, throws rather
 * than returning nothing, so anything that walks every tab in a workbook has
 * to know the difference. Assumes an ordinary grid when the runtime cannot
 * say, which is the safe direction: the caller's own try/catch still holds.
 */
function sheetKind(sh) {
  try {
    var t = sh.getType();
    if (t === SpreadsheetApp.SheetType.DATASOURCE) return 'DATASOURCE';
    if (t === SpreadsheetApp.SheetType.OBJECT) return 'OBJECT';
    return 'GRID';
  } catch (e) {
    return 'GRID';
  }
}

function isGridSheet(sh) {
  return sheetKind(sh) === 'GRID';
}

/** SKUs are compared case-insensitively with surrounding space ignored. */
function normSku(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/** ROUNDUP(x, 0) as Sheets does it: away from zero. */
function roundUp(x) {
  if (!isFinite(x)) return 0;
  return x < 0 ? -Math.ceil(-x) : Math.ceil(x);
}

/** Cases that fit in `units` at `caseQty` per case. */
function casesIn(units, caseQty) {
  if (caseQty <= 0) return 0;
  return Math.floor(units / caseQty);
}

/**
 * A per-SKU minimum number of units to hold at FBA, or 0.
 *
 * These exist for reasons no days-of-cover figure knows about — 101-4001 is
 * held at 100 units on a marketing call — so the number is a hard minimum that
 * outranks every DOI rule on every lane, not a target one lane happens to
 * apply. Both lanes that can reach FBA read it from here.
 */
function unitFloorFor(sku, R) {
  var map = (R && R.FBA_MIN_UNITS_BY_SKU) || {};
  var v = map[normSku(sku)];
  if (!(v > 0)) v = map[String(sku === null || sku === undefined ? '' : sku).trim()];
  return v > 0 ? v : 0;
}

/** Days of inventory. No rate means no finite DOI, which is not the same as 0. */
function doi(units, rate) {
  if (!(rate > 0)) return Infinity;
  return units / rate;
}

function clampMin0(n) {
  return n > 0 ? n : 0;
}

/**
 * The standard DSS ladder used by Tactical>AWD and by AWD>FBA pass 3.
 *
 *   sourceDoi      days of cover at the source  (J on both lanes)
 *   destDoi        days of cover at the destination
 *   availableCases cases on hand at the source
 *   rate           order_plan_rate
 *   caseQty        units per case
 *
 * Mirrors the sheet's IFS in order, including its quirk that a destination
 * sitting exactly on the target yields one case rather than none.
 */
function dssLadder(dss, sourceDoi, destDoi, availableCases, rate, caseQty) {
  if (sourceDoi + destDoi < dss) return availableCases;
  if (dss - destDoi < 0) return 0;
  if ((dss - destDoi) * rate < caseQty) return 1;
  if (dss - destDoi > 0) return roundUp((dss - destDoi) * rate / caseQty);
  return 0;
}

/**
 * A decision, in the shape every lane returns.
 * `notes` are the constraint clauses appended to the reason after the rule.
 */
function decision(cases, rule, opts) {
  var o = opts || {};
  return {
    cases: cases,
    rule: rule,
    notes: o.notes || [],
    pass: o.pass || null,
    flags: o.flags || [],
  };
}

function addNote(d, note) {
  if (note) d.notes.push(note);
  return d;
}

function addFlag(d, flag) {
  if (d.flags.indexOf(flag) === -1) d.flags.push(flag);
  return d;
}

/**
 * The date a planner is for, from its name — `08-10-26`, sometimes with a
 * stray leading space. Returns null when the name is not a date, in which case
 * callers fall back to today rather than guessing.
 */
function plannerDate(name) {
  var m = String(name || '').trim().match(/(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

/** Whether a cell holding a date or a sheet serial falls on `date`. */
function isSameDay(cell, date) {
  if (!date) return false;
  var d = cell;
  if (typeof cell === 'number') {
    d = new Date(Date.UTC(1899, 11, 30) + cell * 86400000);
    return d.getUTCFullYear() === date.getFullYear()
      && d.getUTCMonth() === date.getMonth()
      && d.getUTCDate() === date.getDate();
  }
  if (!(d instanceof Date)) return false;
  return d.getFullYear() === date.getFullYear()
    && d.getMonth() === date.getMonth()
    && d.getDate() === date.getDate();
}

/** Round for display without dragging in a locale. */
function fmt(n, places) {
  var p = places === undefined ? 0 : places;
  if (!isFinite(n)) return '∞';
  var r = Math.round(n * Math.pow(10, p)) / Math.pow(10, p);
  return String(r);
}

/**
 * `<qty> — <rule>[, <constraint>]`, per §9.2.
 * The quantity leads because that is what gets read first when scanning down.
 */
function reasonText(d, caseQty) {
  var qty = d.cases === 0
    ? '0'
    : d.cases + (d.cases === 1 ? ' case' : ' cases');
  var parts = [qty + ' — ' + d.rule];
  var line = parts[0];
  if (d.notes.length) line += ', ' + d.notes.join(', ');
  if (d.flags.indexOf('NEEDS_REVIEW') !== -1) line += '  ⚠ review';
  if (d.flags.indexOf('FLOOR_BREACH') !== -1) line += '  ⚠ FLOOR BREACH';
  return line;
}
