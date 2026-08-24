/**
 * The lanes, as formulas.
 *
 * Every bug this planner has had has been the same bug: a number worked out
 * somewhere else and pasted in, where a failed input silently became zero. A
 * floor that read #REF! became no floor. A rate that failed to load became no
 * demand. The arithmetic was always right and the answer was always wrong, and
 * nothing on the sheet showed which.
 *
 * So the split is: **inputs are values, everything derived is a formula**.
 *
 *   pasted as values   stock, rates, case sizes, lifecycle, the Tactical floor
 *                      — frozen at run time, so the planner stays a record of
 *                      the numbers the decision was actually made on
 *
 *   live formulas      days of cover, cases to transfer, units, cover after
 *                      the transfer — all of it visible, all of it referencing
 *                      the dials on the Settings tab by name
 *
 * Change the rate in column F and the projection moves in front of you. Change
 * `TacAwd_TargetDoi` on the Settings tab from 75 to 90 and the whole column
 * reprices. Nothing has to be re-run to see the effect of a what-if, which is
 * the thing pasted values make impossible.
 *
 * The rule engine in Rules_*.gs still runs, and still writes the reason for
 * every row. After the formulas settle, the two are compared: where they
 * disagree the sheet's number wins — it is the one Marco can see — and the row
 * is flagged. Drift between the two becomes loud instead of silent.
 */

// ------------------------------------------------------------ tiny formula DSL

function quoteTab(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

/** `$H8`. Column locked, row free, so a column can be filled without drift. */
function cellRef(col0, row) {
  return '$' + colLetter(col0) + row;
}

/** The cell as a number: blanks and text read as 0 rather than poisoning the row. */
function numRef(col0, row) {
  return 'N(' + cellRef(col0, row) + ')';
}

/** A VLOOKUP into another lane, keyed on its SKU column. Misses read as 0. */
function laneLookup(cfg, laneKey, keyCol0, valueCol0, keyExpr) {
  return 'IFERROR(VLOOKUP(' + keyExpr + ',' + quoteTab(cfg.TABS[laneKey]) + '!$'
    + colLetter(keyCol0) + ':$' + colLetter(valueCol0) + ','
    + (valueCol0 - keyCol0 + 1) + ',FALSE),0)';
}

/**
 * Whether a flag cell means yes.
 *
 * Spelled out rather than using an array literal, because `{"TRUE";"YES"}`
 * needs a different separator in a non-US locale and would break silently on a
 * sheet opened somewhere else.
 */
function truthyRef(col0, row) {
  var s = 'UPPER(TRIM(' + cellRef(col0, row) + '&""))';
  return 'OR(' + s + '="TRUE",' + s + '="YES",' + s + '="Y",' + s + '="T",'
    + s + '="1")';
}

function isDiscontinuedRef(col0, row) {
  return 'LOWER(TRIM(' + cellRef(col0, row) + '&""))="discontinued"';
}

/** `IF(a, b, c)` written so the nesting stays readable in source. */
function iff(cond, then, other) {
  return 'IF(' + cond + ',' + then + ',' + other + ')';
}

/** Days of cover, blank when there is no rate — 0 would read as an emergency. */
function doiFormula(rateCol, parts, row) {
  var sum = parts.map(function (c) { return numRef(c, row); }).join('+');
  return '=' + iff(numRef(rateCol, row) + '>0',
    '(' + sum + ')/' + numRef(rateCol, row), '""');
}

// -------------------------------------------------------------- work columns

/**
 * The columns the formulas add to the right of Reason.
 *
 * They exist to be read. The Tactical floor kept turning into "the script says
 * 1 case and I cannot see why"; `Drawable after the Tactical floor` puts the
 * number the floor actually allows on the row, next to the number being sent.
 */
function laneWorkColumns(cfg, laneKey) {
  var base = cfg.COLS[laneKey].REASON + 1;
  if (laneKey === 'TAC_TO_AWD') return { DRAWABLE: base, QUALIFY: base + 1 };
  if (laneKey === 'AWD_TO_FBA') {
    return { PASS: base, TARGET: base + 1, NEEDED: base + 2, UNCOVERED: base + 3 };
  }
  return { TARGET: base, CEILING: base + 1, RESIDUAL: base + 2,
    WANTED: base + 3, PROPOSED: base + 4 };
}

function laneWorkHeaders(laneKey) {
  if (laneKey === 'TAC_TO_AWD') {
    return ['Drawable after the Tactical floor (cases)',
      'Qualifying cases (before the pallet test)'];
  }
  if (laneKey === 'AWD_TO_FBA') {
    return ['Pass (1 reserved-blocked · 2 B2B/Critical · 3 baseline)',
      'Target (DOI)', 'Cases needed to reach the target',
      'Cases AWD could not cover'];
  }
  return ['Target (DOI)', 'Ceiling (DOI)', 'Cases AWD could not cover',
    'Wanted, before the ceiling (cases)',
    'Wanted, before Tactical stock and the floor (cases)'];
}

// ------------------------------------------------------ lane: Tactical > AWD

/**
 * Returns { columnIndex: formula } for one row.
 *
 * Pure: no sheet, no I/O, so every formula this planner writes is testable as
 * a string before it ever reaches a cell.
 */
function formulasTacToAwd(row, cfg) {
  var C = cfg.COLS.TAC_TO_AWD;
  var W = laneWorkColumns(cfg, 'TAC_TO_AWD');
  var f = {};

  var rate = numRef(C.ORDER_PLAN_RATE, row);
  var cq = numRef(C.CASE_QTY, row);

  f[C.AVAILABLE_CASES] = '=' + iff(cq + '>0',
    'FLOOR(' + numRef(C.TAC_AVAILABLE, row) + '/' + cq + ')', '""');

  f[C.AWD_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.AWD_QTY, C.AWD_INBOUND_14], row);
  f[C.TOTAL_DOI] = doiFormula(C.ORDER_PLAN_RATE,
    [C.TAC_AVAILABLE, C.AWD_QTY, C.AWD_INBOUND_14], row);
  f[C.AWD_DOI_AFTER] = doiFormula(C.ORDER_PLAN_RATE,
    [C.AWD_QTY, C.AWD_INBOUND_14, C.UNITS_OUT], row);

  f[C.UNITS_OUT] = '=' + numRef(C.CASES_OUT, row) + '*' + cq;

  // What the floor leaves, in cases — after Tactical > FBA has taken its share.
  //
  // Both Tactical lanes draw on one pool and the sheet cannot resolve that
  // circularly, so Tactical > FBA is settled first and its units come off this
  // lane's budget. That is the direction Marco takes by hand: the SPD lane
  // moves small rescue quantities, the palletised lane waits.
  var takenByFba = laneLookup(cfg, 'TAC_TO_FBA', cfg.COLS.TAC_TO_FBA.NAME,
    cfg.COLS.TAC_TO_FBA.UNITS_OUT, cellRef(C.NAME, row));

  f[W.DRAWABLE] = '=' + iff(cq + '<=0', '0',
    iff('ISERROR(' + cellRef(C.MIN_UNITS, row) + ')', '0',
      'FLOOR(MAX(0,' + numRef(C.TAC_AVAILABLE, row) + '-'
        + numRef(C.MIN_UNITS, row) + '-' + takenByFba + ')/' + cq + ')'));

  // Qualifying demand, before the pallet test. Short at BOTH ends or nothing:
  // thin at AWD while FBA is comfortable is not a reason to move a pallet.
  var want = 'ROUNDUP((' + SETTINGS_NAMES.TAC_AWD_TARGET + '-'
    + numRef(C.AWD_DOI, row) + ')*' + rate + '/' + cq + ',0)';

  f[W.QUALIFY] = '='
    + iff(cellRef(C.NAME, row) + '=""', '""',
      iff(isDiscontinuedRef(C.LIFECYCLE, row), '0',
        iff(rate + '<=0', '0',
          iff(cq + '<=0', '0',
            // An unreadable FBA figure is not zero cover. Read as zero it looks
            // like the most desperate row on the tab and walks straight through
            // a gate meant to keep it out.
            iff('NOT(ISNUMBER(' + cellRef(C.FBA_DOI, row) + '))', '0',
              iff(numRef(C.AWD_DOI, row) + '>=' + SETTINGS_NAMES.TAC_AWD_GATE_AWD, '0',
                iff(numRef(C.FBA_DOI, row) + '>=' + SETTINGS_NAMES.TAC_AWD_GATE_FBA, '0',
                  'MAX(0,MIN(' + want + ',' + numRef(C.AVAILABLE_CASES, row)
                    + ',' + numRef(W.DRAWABLE, row) + '))')))))));

  // The pallet test is a property of the run, not of the row, so it lives in
  // one cell on Settings and every row reads the same answer.
  f[C.CASES_OUT] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff(SETTINGS_NAMES.RUN_TAC_AWD_VERDICT + '="RAISE"',
      numRef(W.QUALIFY, row), '0'));

  return f;
}

// ---------------------------------------------------------- lane: AWD > FBA

function formulasAwdToFba(row, cfg) {
  var C = cfg.COLS.AWD_TO_FBA;
  var W = laneWorkColumns(cfg, 'AWD_TO_FBA');
  var f = {};

  var rate = numRef(C.ORDER_PLAN_RATE, row);
  var cq = numRef(C.CASE_QTY, row);

  // Pass 1 measures cover on true_rate_30, falling back to the order plan rate
  // when there isn't one. On 08-13 that is the difference between 2 cases and
  // 5 on 101-1068; 2 is what shipped.
  var p1rate = cfg.RULES.PASS1_RATE === 'order_plan_rate'
    ? rate
    : iff(numRef(C.TRUE_RATE_30, row) + '>0', numRef(C.TRUE_RATE_30, row), rate);

  f[C.AVAILABLE_CASES] = '=' + iff(cq + '>0',
    'FLOOR(' + numRef(C.AWD_AVAILABLE, row) + '/' + cq + ')', '""');
  f[C.AWD_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.AWD_AVAILABLE], row);
  f[C.AMZ_TOTAL] = '=' + [C.AMZ_FULFILLABLE, C.AMZ_RESERVED, C.AMZ_INBOUND]
    .map(function (c) { return numRef(c, row); }).join('+');
  f[C.AMZ_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.AMZ_TOTAL], row);
  f[C.UNITS_OUT] = '=' + numRef(C.CASES_OUT, row) + '*' + cq;
  f[C.TOTAL_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.AWD_AVAILABLE, C.AMZ_TOTAL], row);
  f[C.AMZ_DOI_AFTER] = doiFormula(C.ORDER_PLAN_RATE, [C.AMZ_TOTAL, C.UNITS_OUT], row);

  // X — reserved against fulfillable. All reserved and none fulfillable is not
  // a ratio of zero; it is the most blocked a SKU can be.
  f[C.RESERVED_RATIO] = '=' + iff(numRef(C.AMZ_FULFILLABLE, row) + '>0',
    numRef(C.AMZ_RESERVED, row) + '/' + numRef(C.AMZ_FULFILLABLE, row),
    iff(numRef(C.AMZ_RESERVED, row) + '>0', '"all reserved"', '0'));

  // Y — days of cover on fulfillable stock alone, on the pass-1 rate, so the
  // sheet shows the number the rule actually reads.
  f[C.AVAILABLE_ONLY_DOI] = '=' + iff(p1rate + '>0',
    numRef(C.AMZ_FULFILLABLE, row) + '/' + p1rate, '""');

  var ratio = iff(numRef(C.AMZ_FULFILLABLE, row) + '>0',
    numRef(C.AMZ_RESERVED, row) + '/' + numRef(C.AMZ_FULFILLABLE, row),
    iff(numRef(C.AMZ_RESERVED, row) + '>0', '1E+99', '0'));

  var priority = 'OR(' + truthyRef(C.B2B, row) + ',' + truthyRef(C.CRITICAL, row) + ')';

  f[W.PASS] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff(rate + '<=0', '0',
      iff('AND(' + ratio + '>' + SETTINGS_NAMES.AWD_FBA_RESERVED_RATIO + ','
        + numRef(C.AVAILABLE_ONLY_DOI, row) + '<'
        + SETTINGS_NAMES.AWD_FBA_PASS1_TRIGGER + ')', '1',
        iff('AND(' + priority + ',' + numRef(C.AMZ_DOI, row) + '<'
          + SETTINGS_NAMES.AWD_FBA_PASS2_TRIGGER + ')', '2', '3'))));

  // The one ceiling every pass respects: total FBA cover after the transfer.
  var ceiling = 'MAX(0,FLOOR((' + SETTINGS_NAMES.AWD_FBA_MAX_AFTER + '*' + rate
    + '-' + numRef(C.AMZ_TOTAL, row) + ')/' + cq + '))';

  var p1 = 'MIN(MAX(0,ROUNDUP((' + SETTINGS_NAMES.AWD_FBA_PASS1_TARGET + '-'
    + numRef(C.AVAILABLE_ONLY_DOI, row) + ')*' + p1rate + '/' + cq + ',0)),'
    + ceiling + ')';

  var p2 = 'MAX(0,ROUNDUP((' + SETTINGS_NAMES.PRIORITY_DOI + '-'
    + numRef(C.AMZ_DOI, row) + ')*' + rate + '/' + cq + ',0))';

  // The sheet's own IFS ladder, in its order — including the quirk that a
  // destination sitting exactly on target yields one case rather than none.
  var dss = SETTINGS_NAMES.DSS;
  var gap = '(' + dss + '-' + numRef(C.AMZ_DOI, row) + ')';
  var ladder = iff(numRef(C.AWD_DOI, row) + '+' + numRef(C.AMZ_DOI, row) + '<' + dss,
    numRef(C.AVAILABLE_CASES, row),
    iff(gap + '<0', '0',
      iff(gap + '*' + rate + '<' + cq, '1',
        iff(gap + '>0', 'ROUNDUP(' + gap + '*' + rate + '/' + cq + ',0)', '0'))));
  var p3 = 'MIN(' + ladder + ',' + ceiling + ')';

  f[C.CASES_OUT] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff(rate + '<=0', '0',
      iff(cq + '<=0', '0',
        'MAX(0,MIN(' + numRef(C.AVAILABLE_CASES, row) + ','
          + iff(numRef(W.PASS, row) + '=1', p1,
            iff(numRef(W.PASS, row) + '=2', p2, p3)) + '))')));

  // What this lane leaves on the table, and whether AWD stock is the reason.
  //
  // That distinction is the whole gate for Tactical > FBA. Hitting the 110
  // ceiling or a priority target is a decision, not a shortage, and must not
  // open the residual lane; running AWD dry is exactly a shortage.
  //
  // Split across three columns rather than nested into one, because a formula
  // nobody can read is no more visible than a pasted value — and "what is this
  // SKU aiming at" and "how far short is it" are worth seeing on the row.
  f[W.TARGET] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff(priority, SETTINGS_NAMES.PRIORITY_DOI, dss));

  f[W.NEEDED] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      'MAX(0,ROUNDUP((' + numRef(W.TARGET, row) + '-' + numRef(C.AMZ_DOI, row)
        + ')*' + rate + '/' + cq + ',0))'));

  var short = 'MAX(0,' + numRef(W.NEEDED, row) + '-' + numRef(C.CASES_OUT, row) + ')';
  var freeUnits = 'MAX(0,' + numRef(C.AWD_AVAILABLE, row) + '-'
    + numRef(C.UNITS_OUT, row) + ')';

  f[W.UNCOVERED] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      iff('AND(' + short + '>0,' + freeUnits + '<' + short + '*' + cq + ')',
        short, '0')));

  return f;
}

// ------------------------------------------------------ lane: Tactical > FBA

function formulasTacToFba(row, cfg) {
  var C = cfg.COLS.TAC_TO_FBA;
  var A = cfg.COLS.AWD_TO_FBA;
  var AW = laneWorkColumns(cfg, 'AWD_TO_FBA');
  var W = laneWorkColumns(cfg, 'TAC_TO_FBA');
  var f = {};

  var rate = numRef(C.ORDER_PLAN_RATE, row);
  var cq = numRef(C.CASE_QTY, row);
  var sku = cellRef(C.NAME, row);

  f[C.AVAILABLE_CASES] = '=' + iff(cq + '>0',
    'FLOOR(' + numRef(C.TAC_AVAILABLE, row) + '/' + cq + ')', '""');
  f[C.TAC_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.TAC_AVAILABLE], row);
  f[C.AMZ_TOTAL] = '=' + [C.AMZ_FULFILLABLE, C.AMZ_RESERVED, C.AMZ_INBOUND]
    .map(function (c) { return numRef(c, row); }).join('+');
  f[C.AMZ_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.AMZ_TOTAL], row);
  f[C.UNITS_OUT] = '=' + numRef(C.CASES_OUT, row) + '*' + cq;
  f[C.TOTAL_DOI] = doiFormula(C.ORDER_PLAN_RATE, [C.TAC_AVAILABLE, C.AMZ_TOTAL], row);
  f[C.AMZ_DOI_AFTER] = doiFormula(C.ORDER_PLAN_RATE, [C.AMZ_TOTAL, C.UNITS_OUT], row);

  // What the AWD > FBA lane is sending this run, so the residual test is
  // visible on the row rather than implied by it.
  f[C.TO_AWD_TO_FBA] = '=' + laneLookup(cfg, 'AWD_TO_FBA', A.NAME, A.UNITS_OUT, sku);

  var floorUnits = 'IFERROR(VLOOKUP(' + sku + ',' + SETTINGS_NAMES.FBA_MIN_UNITS
    + ',2,FALSE),0)';
  var disc = isDiscontinuedRef(C.LIFECYCLE, row);
  var priority = 'OR(' + truthyRef(C.B2B, row) + ',' + truthyRef(C.CRITICAL, row) + ')';

  // A per-SKU unit floor beats every DOI rule — it exists precisely because
  // days-of-cover is the wrong measure for that line. 101-4001 is held at 100
  // units on a marketing call.
  f[W.TARGET] = '=' + iff(rate + '<=0', '""',
    iff(floorUnits + '>0', floorUnits + '/' + rate,
      iff(disc, SETTINGS_NAMES.TAC_FBA_DISC_AIM,
        iff(priority, SETTINGS_NAMES.PRIORITY_DOI, SETTINGS_NAMES.DSS))));

  f[W.CEILING] = '=' + iff(rate + '<=0', '""',
    iff(floorUnits + '>0', floorUnits + '/' + rate,
      iff(disc, SETTINGS_NAMES.TAC_FBA_DISC_MAX,
        numRef(W.TARGET, row) + '*' + SETTINGS_NAMES.TAC_FBA_SPIKE)));

  // Gate 1 — strictly residual. The lane opens only where AWD wanted to send
  // more and ran out of stock, or where the SKU has no AWD stock at all.
  var uncovered = laneLookup(cfg, 'AWD_TO_FBA', A.NAME, AW.UNCOVERED, sku);
  f[W.RESIDUAL] = '=' + iff(sku + '=""', '""',
    iff('ISNA(MATCH(' + sku + ',' + quoteTab(cfg.TABS.AWD_TO_FBA) + '!$'
      + colLetter(A.NAME) + ':$' + colLetter(A.NAME) + ',0))',
      iff(numRef(C.AWD_AVAILABLE, row) + '<=0', '9999', '0'),
      uncovered));

  // Gate 2 — nothing already on its way into AWD inside 14 days.
  var inbound = laneLookup(cfg, 'TAC_TO_AWD', cfg.COLS.TAC_TO_AWD.NAME,
    cfg.COLS.TAC_TO_AWD.AWD_INBOUND_14, sku);

  var amzDoi = numRef(C.AMZ_DOI, row);
  var target = numRef(W.TARGET, row);
  var ceiling = numRef(W.CEILING, row);

  var toFloor = 'MAX(0,ROUNDUP((' + floorUnits + '-' + numRef(C.AMZ_TOTAL, row)
    + ')/' + cq + ',0))';
  // Liquidating: push stock down towards the aim, whatever the cover says.
  var toAim = 'MAX(1,FLOOR((' + target + '-' + amzDoi + ')*' + rate + '/' + cq + '))';
  var toTarget = iff(amzDoi + '>=' + target, '0', toAim);

  f[W.WANTED] = '=' + iff(sku + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      iff(floorUnits + '>0', toFloor, iff(disc, toAim, toTarget))));

  // Gate 4 — and it must not spike FBA cover. One case is allowed to overshoot
  // the target; nothing is allowed to cross the ceiling.
  var raw = numRef(W.WANTED, row);
  var fits = 'FLOOR((' + ceiling + '*' + rate + '-' + numRef(C.AMZ_TOTAL, row)
    + ')/' + cq + ')';
  var afterSpike = iff(raw + '<=0', '0', iff(fits + '>=1', 'MIN(' + raw + ',' + fits + ')', '0'));

  // What the row wants once the gates and the ceiling have had their say, but
  // before Tactical stock and the floor do. Kept as its own column because it
  // is the number the floor-breach test reads, and because "wanted 20, sending
  // 10" is the question the reason column keeps being asked.
  f[W.PROPOSED] = '=' + iff(sku + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      iff(numRef(W.RESIDUAL, row) + '<=0', '0',
        iff(inbound + '>0', '0', 'MAX(0,' + afterSpike + ')'))));

  var proposed = numRef(W.PROPOSED, row);

  // §7.1 — the Tactical floor may be broken, but only on this lane, only when
  // AWD is empty, FBA is genuinely thin, and the transfer restores cover to
  // roughly the baseline. A rescue, not a top-up. And only because this lane
  // ships SPD: Tactical > AWD is palletised and may never break it.
  var restored = '(' + numRef(C.AMZ_TOTAL, row) + '+' + proposed + '*' + cq
    + ')/' + rate;
  var lo = '(' + SETTINGS_NAMES.TAC_FBA_BREACH_RESTORE + '*(1-'
    + SETTINGS_NAMES.TAC_FBA_BREACH_TOLERANCE + '))';
  var hi = '(' + SETTINGS_NAMES.TAC_FBA_BREACH_RESTORE + '*(1+'
    + SETTINGS_NAMES.TAC_FBA_BREACH_TOLERANCE + '))';
  var breach = 'AND(' + numRef(C.AWD_AVAILABLE, row) + '<=0,'
    + amzDoi + '<' + SETTINGS_NAMES.TAC_FBA_BREACH_MAX + ','
    + restored + '>=' + lo + ',' + restored + '<=' + hi + ')';

  var floorCap = 'FLOOR(MAX(0,' + numRef(C.TAC_AVAILABLE, row) + '-'
    + numRef(C.MIN_UNITS, row) + ')/' + cq + ')';
  var stockCapped = 'MIN(' + proposed + ',' + numRef(C.AVAILABLE_CASES, row) + ')';

  f[C.CASES_OUT] = '=' + iff(sku + '=""', '""',
    iff(proposed + '<=0', '0',
      iff(breach, stockCapped,
        iff('ISERROR(' + cellRef(C.MIN_UNITS, row) + ')', '0',
          'MAX(0,MIN(' + stockCapped + ',' + floorCap + '))'))));

  return f;
}

// ----------------------------------------------------------------- writing

var LANE_FORMULA_BUILDERS = {
  TAC_TO_AWD: formulasTacToAwd,
  AWD_TO_FBA: formulasAwdToFba,
  TAC_TO_FBA: formulasTacToFba,
};

/**
 * Write one lane's derived columns.
 *
 * `rowCount` rows starting at the first data row. Formulas go in column by
 * column — one setFormulas() per column rather than per cell, which is the
 * difference between a run that finishes and one that times out on 491 rows.
 */
function writeLaneFormulas(sheet, laneKey, rowCount, cfg) {
  if (!sheet || rowCount <= 0) return { lane: laneKey, ok: false, note: 'no rows' };
  if (!isGridSheet(sheet)) {
    return { lane: laneKey, ok: false, note: 'Connected Sheet — cannot write formulas' };
  }

  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var build = LANE_FORMULA_BUILDERS[laneKey];
  var work = laneWorkColumns(cfg, laneKey);

  var widest = cfg.COLS[laneKey].REASON;
  Object.keys(work).forEach(function (k) { widest = Math.max(widest, work[k]); });
  ensureColumns(sheet, widest + 1);

  // Build the whole block first, so a bad column index throws before anything
  // is written rather than half way through.
  var byColumn = {};
  for (var i = 0; i < rowCount; i++) {
    var f = build(first + i, cfg);
    Object.keys(f).forEach(function (col) {
      if (!byColumn[col]) byColumn[col] = [];
      byColumn[col].push([f[col]]);
    });
  }

  Object.keys(byColumn).forEach(function (col) {
    sheet.getRange(first, Number(col) + 1, rowCount, 1).setFormulas(byColumn[col]);
  });

  // Anything below the SKUs is a previous run's tail. Leaving it there is how
  // a 29-row lane keeps reporting 491 rows of arithmetic on nothing.
  var tail = sheet.getLastRow() - (first + rowCount) + 1;
  if (tail > 0) {
    sheet.getRange(first + rowCount, 1, tail, sheet.getMaxColumns()).clearContent();
  }

  writeWorkHeaders(sheet, laneKey, cfg);
  return { lane: laneKey, ok: true, rows: rowCount, columns: Object.keys(byColumn).length };
}

/**
 * How many data rows each lane actually has, counted on the SKU column.
 *
 * Not getLastRow(): a previous run's formulas can sit hundreds of rows below
 * the last SKU, and taking the sheet's word for it is what let 491 rows of
 * decisions accumulate on a lane with 29 products.
 */
function laneRowCounts(planner, cfg) {
  var out = {};
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach(function (k) {
    var sh = sheetByName(planner, cfg.TABS[k]);
    out[k] = sh && isGridSheet(sh) ? laneRowCount(sh, k, cfg) : 0;
  });
  return out;
}

function laneRowCount(sheet, laneKey, cfg) {
  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var last = sheet.getLastRow();
  if (last < first) return 0;
  var vals = sheet.getRange(first, cfg.COLS[laneKey].NAME + 1, last - first + 1, 1)
    .getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0] === null || vals[i][0] === undefined ? '' : vals[i][0]).trim()) {
      return i + 1;
    }
  }
  return 0;
}

function writeWorkHeaders(sheet, laneKey, cfg) {
  var work = laneWorkColumns(cfg, laneKey);
  var headers = laneWorkHeaders(laneKey);
  var cols = Object.keys(work).map(function (k) { return work[k]; })
    .sort(function (a, b) { return a - b; });
  cols.forEach(function (c, i) {
    var cell = sheet.getRange(cfg.LAYOUT.LANE_HEADER_ROW, c + 1);
    cell.setValue(headers[i]);
    cell.setBackground(cfg.COLOURS.HEADER);
    cell.setFontWeight('bold');
    cell.setWrap(true);
  });
}

/**
 * Config with every tab name replaced by the workbook's actual spelling.
 *
 * `sheetByName()` trims and lower-cases before matching, so the script has
 * always found the right tab whatever the spelling. A formula cannot: the name
 * is embedded in the string, and one character out makes every cross-lane
 * lookup #REF!. The Tactical > AWD tab really is called "US TO Tactical > AWD "
 * with a trailing space, and nothing about that is going to stay true forever.
 *
 * So the names are resolved once, from the file, before a single formula is
 * built.
 */
function resolveTabNames(planner, cfg) {
  var out = JSON.parse(JSON.stringify(cfg));
  Object.keys(out.TABS).forEach(function (key) {
    var sh = sheetByName(planner, out.TABS[key]);
    if (sh) out.TABS[key] = sh.getName();
  });
  return out;
}

/**
 * All three lanes, in dependency order.
 *
 * AWD > FBA first because Tactical > FBA is residual to it, and Tactical > FBA
 * before Tactical > AWD because its units come off the same Tactical pool. The
 * order does not matter to Sheets, which resolves the graph itself — it
 * matters to anyone reading this and wondering whether it can loop. It cannot:
 * each lane only ever looks upstream.
 */
function writeAllFormulas(planner, rowCounts, cfg) {
  return ['AWD_TO_FBA', 'TAC_TO_FBA', 'TAC_TO_AWD'].map(function (k) {
    return writeLaneFormulas(sheetByName(planner, cfg.TABS[k]), k,
      rowCounts[k] || 0, cfg);
  });
}

/**
 * Read back what the sheet worked out, per lane, as cases.
 * Returns [] when the lane is missing rather than throwing — the caller has a
 * better error to give than this one does.
 */
function readLaneCases(sheet, rowCount, laneKey, cfg) {
  if (!sheet || rowCount <= 0) return [];
  var col = cfg.COLS[laneKey].CASES_OUT + 1;
  var vals = sheet.getRange(cfg.LAYOUT.LANE_FIRST_DATA_ROW, col, rowCount, 1)
    .getValues();
  return vals.map(function (r) { return num(r[0], 0); });
}

// --------------------------------------------------------- keeping them honest

/**
 * Settle the sheet's numbers against the rule engine's.
 *
 * Two implementations of the same rules will drift. The answer is not to hope
 * they don't — it is to compare them on every run and make a disagreement
 * impossible to miss.
 *
 * Where they differ, **the sheet wins**: it is the number on the row, the one
 * that gets picked and shipped, and the one Marco can trace back through its
 * own arguments. The rule engine's answer is kept as a note on the row so the
 * difference is legible rather than merely flagged.
 *
 * Everything downstream — reasons, summary tabs, CSV tabs, the history log —
 * then reads one number, so the workbook cannot contradict itself.
 *
 * Returns { checked, differed, examples } for the run header.
 */
function reconcileWithSheet(input, plan, cfg) {
  var lanes = [
    { key: 'TAC_TO_AWD', rows: input.tacToAwd, dec: plan.tacToAwd, sheet: input.sheets.tacToAwd },
    { key: 'AWD_TO_FBA', rows: input.awdToFba, dec: plan.awdToFba, sheet: input.sheets.awdToFba },
    { key: 'TAC_TO_FBA', rows: input.tacToFba, dec: plan.tacToFba, sheet: input.sheets.tacToFba },
  ];

  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var out = { checked: 0, differed: 0, examples: [] };

  lanes.forEach(function (lane) {
    if (!lane.sheet || !lane.rows.length) return;
    var span = lane.rows[lane.rows.length - 1].rowIndex - first + 1;
    var sheetCases = readLaneCases(lane.sheet, span, lane.key, cfg);

    lane.rows.forEach(function (r, i) {
      var d = lane.dec[i];
      if (!d) return;
      var was = d.cases > 0 ? d.cases : 0;
      var now = Math.max(0, Math.round(sheetCases[r.rowIndex - first] || 0));
      out.checked++;
      if (now === was) return;

      out.differed++;
      if (out.examples.length < 5) {
        out.examples.push(lane.key + ' ' + r.sku + ': sheet ' + now
          + ', rules ' + was);
      }
      d.cases = now;
      addNote(d, 'sheet formula gives ' + now + ' where the rule engine gave '
        + was + ' — the sheet is what ships; check the Settings tab');
      addFlag(d, 'NEEDS_REVIEW');
    });
  });

  // The totals were computed from the pre-reconciliation numbers.
  plan.totals.tacToAwdCases = sumCases(plan.tacToAwd);
  plan.totals.awdToFbaCases = sumCases(plan.awdToFba);
  plan.totals.tacToFbaCases = sumCases(plan.tacToFba);
  plan.totals.needsReview = countFlag(plan.tacToAwd, 'NEEDS_REVIEW')
    + countFlag(plan.awdToFba, 'NEEDS_REVIEW')
    + countFlag(plan.tacToFba, 'NEEDS_REVIEW');
  plan.reconcile = out;

  return out;
}
