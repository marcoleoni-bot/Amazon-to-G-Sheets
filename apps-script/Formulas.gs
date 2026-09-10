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

/**
 * A lookup into another lane, keyed on its SKU column. Misses read as 0.
 *
 * INDEX/MATCH over two single columns, never VLOOKUP over a block.
 *
 * VLOOKUP($C8,'US TO Tactical > FBA'!$D:$S,16,FALSE) makes this cell depend on
 * *sixteen whole columns* of the other lane. The other lane has its own lookup
 * pointing back here, over ten of ours. Neither individual cell forms a loop —
 * both point at input columns in the end — but Sheets resolves open ranges at
 * range granularity, sees two sheets each referencing a wide slab of the
 * other, and calls it a circular dependency. The whole transfer column then
 * reads #REF!, and no amount of IFERROR hides it, because a circular cell is
 * marked circular rather than given an error value to catch.
 *
 * INDEX/MATCH narrows each edge to exactly two columns — the SKU column, which
 * is always a pasted value, and the one column actually wanted. The dependency
 * graph is then provably acyclic column by column, which is what
 * `test/planner-formulas.test.js` checks on every run. It is also far cheaper:
 * a block VLOOKUP over 491 rows × 16 columns × 3 lanes is a lot of scanning to
 * fetch one number.
 */
function laneLookup(cfg, laneKey, keyCol0, valueCol0, keyExpr) {
  var tab = quoteTab(cfg.TABS[laneKey]);
  var value = '$' + colLetter(valueCol0) + ':$' + colLetter(valueCol0);
  var key = '$' + colLetter(keyCol0) + ':$' + colLetter(keyCol0);
  return 'IFERROR(INDEX(' + tab + '!' + value + ',MATCH(' + keyExpr + ','
    + tab + '!' + key + ',0)),0)';
}

/**
 * Whether a flag cell means yes.
 *
 * Read as "anything but a no", because the two flag columns on these lanes do
 * not agree on what a yes looks like:
 *
 *   B2B        column A, a plain 0 or 1
 *   Critical?  column B, =IFERROR(VLOOKUP(C8,CRITICAL!B:B,1,0),"NO")
 *
 * That second one returns **the SKU itself** when the row is on the CRITICAL
 * tab, and the string "NO" when it is not. Testing for TRUE/YES/Y/T/1 matched
 * the numeric B2B flag and never matched a SKU, so every Critical SKU fell
 * through to pass 3 and was topped up to the 60-day baseline instead of 100.
 * 101-2092-B and 401-1001-B are both on the CRITICAL tab and both landed on
 * `Pass 3, Target 60`.
 *
 * So the sentinels are named and everything else that is present counts. An
 * unreadable cell reads as no, which is the safe direction: it leaves the SKU
 * on the baseline rather than promoting it on a cell nobody can see.
 *
 * Spelled out rather than using an array literal, because `{"TRUE";"YES"}`
 * needs a different separator in a non-US locale and would break silently on a
 * sheet opened somewhere else.
 */
function truthyRef(col0, row) {
  var s = 'UPPER(TRIM(' + cellRef(col0, row) + '&""))';
  var no = ['', 'NO', 'N', 'FALSE', '0', 'NONE', 'N/A', '#N/A', '-'];
  return 'IFERROR(AND(' + no.map(function (v) {
    return s + '<>"' + v + '"';
  }).join(',') + '),FALSE)';
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
  var floorUnits = 'IFERROR(VLOOKUP(' + cellRef(C.NAME, row) + ','
    + SETTINGS_NAMES.FBA_MIN_UNITS + ',2,FALSE),0)';

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

  // A per-SKU unit floor at FBA is a minimum to hold, not a days-of-cover
  // judgement, so it is met here — on the lane that normally feeds FBA — and
  // it beats the passes and the 110 ceiling alike. It reaches the quantity
  // through the target column, so `Cases needed to reach the target` already
  // reads as the floor requirement and the shortfall carried to Tactical > FBA
  // is measured against the floor too.
  var floorNeed = iff(floorUnits + '>0', numRef(W.NEEDED, row), '0');

  f[C.CASES_OUT] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff(rate + '<=0', '0',
      iff(cq + '<=0', '0',
        'MAX(0,MIN(' + numRef(C.AVAILABLE_CASES, row) + ',MAX(' + floorNeed + ','
          + iff(numRef(W.PASS, row) + '=1', p1,
            iff(numRef(W.PASS, row) + '=2', p2, p3)) + ')))')));

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
    iff(rate + '<=0', '""',
      iff(floorUnits + '>0', floorUnits + '/' + rate,
        iff(priority, SETTINGS_NAMES.PRIORITY_DOI, dss))));

  // With a unit floor the requirement is counted in units, not derived back
  // out of the target's days of cover: (floor/rate − total/rate) × rate is
  // floor − total only in exact arithmetic, and one ULP the wrong way rounds
  // up to an extra case.
  f[W.NEEDED] = '=' + iff(cellRef(C.NAME, row) + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      iff(floorUnits + '>0',
        'MAX(0,ROUNDUP((' + floorUnits + '-' + numRef(C.AMZ_TOTAL, row)
          + ')/' + cq + ',0))',
        'MAX(0,ROUNDUP((' + numRef(W.TARGET, row) + '-' + numRef(C.AMZ_DOI, row)
          + ')*' + rate + '/' + cq + ',0))')));

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
  var onAwdLane = 'ISNA(MATCH(' + sku + ',' + quoteTab(cfg.TABS.AWD_TO_FBA) + '!$'
    + colLetter(A.NAME) + ':$' + colLetter(A.NAME) + ',0))';
  f[W.RESIDUAL] = '=' + iff(sku + '=""', '""',
    iff(onAwdLane, iff(numRef(C.AWD_AVAILABLE, row) + '<=0', '9999', '0'),
      uncovered));

  // Gate 2 — nothing already on its way into AWD inside 14 days.
  var inbound = laneLookup(cfg, 'TAC_TO_AWD', cfg.COLS.TAC_TO_AWD.NAME,
    cfg.COLS.TAC_TO_AWD.AWD_INBOUND_14, sku);

  var amzDoi = numRef(C.AMZ_DOI, row);
  var target = numRef(W.TARGET, row);
  var ceiling = numRef(W.CEILING, row);

  // The unit floor nets off whatever AWD > FBA is already sending this run —
  // column X — so the two lanes fill it once between them rather than twice.
  var toFloor = 'MAX(0,ROUNDUP((' + floorUnits + '-' + numRef(C.AMZ_TOTAL, row)
    + '-' + numRef(C.TO_AWD_TO_FBA, row) + ')/' + cq + ',0))';
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
  //
  // A SKU with a unit floor walks past all three of them. The residual gate
  // asks whether AWD could have covered a *days-of-cover* target, and the
  // inbound gate asks whether replenishment is on its way to AWD; neither is
  // the question when the instruction is "never hold fewer than 100 units at
  // FBA". The spike ceiling is skipped for the same reason: the floor is both
  // the target and the ceiling, and rounding up to a whole case is exactly the
  // indivisible-case allowance every other lane gets. What is left is the
  // arithmetic — the floor, less what is at FBA, less what AWD is sending.
  f[W.PROPOSED] = '=' + iff(sku + '=""', '""',
    iff('OR(' + rate + '<=0,' + cq + '<=0)', '0',
      iff(floorUnits + '>0', raw,
        iff(numRef(W.RESIDUAL, row) + '<=0', '0',
          iff(inbound + '>0', '0', 'MAX(0,' + afterSpike + ')')))));

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
  if (!sheet) return { lane: laneKey, ok: false, note: 'no such tab' };
  if (!isGridSheet(sheet)) {
    return { lane: laneKey, ok: false, note: 'Connected Sheet — cannot write formulas' };
  }

  // The count is settled against the SKUs actually on the tab. The hint from
  // the refresh is only a fallback for when there was no refresh at all.
  //
  // It used to take the larger of the two, which is precisely backwards: the
  // larger number is the broken one every time. On 09-09 the refresh reported
  // 5,734 rows for Tactical > AWD — it had read the IMS tab's last row rather
  // than its last SKU — and taking the maximum spread transfer formulas over
  // all of them.
  // A filter hides rows, and Apps Script will not write to a row a filter has
  // hidden. It fails the way this whole project keeps failing — silently, with
  // no exception, leaving the cells exactly as they were.
  //
  // On 09-09 the Tactical > FBA tab carried a filter showing only rows where
  // the transfer column was 3 or 7. Two rows out of 491 took the formulas, and
  // the run said it had succeeded. A later copy of the same template had a
  // filter with an empty criteria list, which hides everything, and then not
  // one of the fourteen columns would take a formula at all.
  //
  // The criteria refer to last run's numbers and are meaningless against this
  // run's, so the filter is removed rather than preserved — and any rows hidden
  // by hand are shown, for the same reason.
  var unfiltered = unhideForWriting(sheet);

  var counted = laneRowCount(sheet, laneKey, cfg);
  var rows = counted > 0 ? counted : rowCount;
  if (rows <= 0) {
    return { lane: laneKey, ok: false,
      note: 'no SKUs on the tab — nothing to calculate' };
  }

  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var build = LANE_FORMULA_BUILDERS[laneKey];
  var work = laneWorkColumns(cfg, laneKey);

  var widest = cfg.COLS[laneKey].REASON;
  Object.keys(work).forEach(function (k) { widest = Math.max(widest, work[k]); });
  ensureColumns(sheet, widest + 1);

  // Clear the tail *first*, and against getMaxRows() rather than getLastRow().
  //
  // Clearing afterwards used to be conditional on getLastRow(), and getLastRow()
  // is exactly the number a previous over-long write has already corrupted: on
  // 09-09 the Tactical > AWD tab carried transfer formulas down to row 5741
  // against 491 rows of data, so the clear computed a tail of nothing and left
  // all 5,243 of them in place. Clearing up front, to the bottom of the grid,
  // cannot be defeated by the state it is meant to repair.
  var below = sheet.getMaxRows() - (first + rows) + 1;
  if (below > 0) {
    sheet.getRange(first + rows, 1, below, sheet.getMaxColumns()).clearContent();
  }

  // Build the whole block first, so a bad column index throws before anything
  // is written rather than half way through.
  var byColumn = {};
  for (var i = 0; i < rows; i++) {
    var f = build(first + i, cfg);
    Object.keys(f).forEach(function (col) {
      if (!byColumn[col]) byColumn[col] = [];
      byColumn[col].push([f[col]]);
    });
  }

  writeColumnBlocks(sheet, byColumn, first, rows);

  // Read every column back and compare it with what was meant to go there.
  //
  // Checking only that *a* formula is present is not enough, and the 09-09
  // run is why: AWD > FBA's transfer column came back holding the template's
  // own `ROUNDUP((100-O8)*F8/Q8,0)`. Our write to that one column had been
  // dropped — silently, with no exception, while the other thirteen landed —
  // and a "is it a formula?" test waved it through.
  var missed = unwrittenColumns(sheet, byColumn, first);
  if (missed.length) {
    SpreadsheetApp.flush();
    writeColumnBlocks(sheet, byColumn, first, rows);
    SpreadsheetApp.flush();
    missed = unwrittenColumns(sheet, byColumn, first);
  }

  writeWorkHeaders(sheet, laneKey, cfg);

  if (missed.length) {
    return { lane: laneKey, ok: false, rows: rows,
      note: 'these columns would not take a formula, twice over: '
        + missed.map(function (c) { return colLetter(Number(c)); }).join(', ') };
  }

  return {
    lane: laneKey, ok: true, rows: rows, counted: counted, hinted: rowCount || 0,
    columns: Object.keys(byColumn).length, unfiltered: unfiltered,
  };
}

/**
 * Write the block, one call per run of adjacent columns.
 *
 * Fourteen separate single-column writes per lane is fourteen chances for one
 * to go missing; grouping the adjacent ones cuts AWD > FBA from fourteen calls
 * to six and Tactical > AWD from eight to four.
 */
function writeColumnBlocks(sheet, byColumn, first, rows) {
  var cols = Object.keys(byColumn).map(Number).sort(function (a, b) { return a - b; });
  var i = 0;
  while (i < cols.length) {
    var j = i;
    while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    var width = j - i + 1;
    var block = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var k = i; k <= j; k++) row.push(byColumn[cols[k]][r][0]);
      block.push(row);
    }
    sheet.getRange(first, cols[i] + 1, rows, width).setFormulas(block);
    i = j + 1;
  }
}

/** Columns whose first row does not hold the formula we asked for. */
function unwrittenColumns(sheet, byColumn, first) {
  return Object.keys(byColumn).filter(function (col) {
    var want = byColumn[col][0][0];
    var got;
    try {
      got = sheet.getRange(first, Number(col) + 1).getFormula();
    } catch (e) {
      return true;
    }
    return !sameFormula(got, want);
  });
}

/**
 * Are these the same formula?
 *
 * Compared on a normalised prefix, because Sheets rewrites what it stores:
 * `FLOOR(x)` comes back as `FLOOR(x,1)`, and whitespace moves. Twenty
 * characters is past the opening `IF(` of every formula here and short of the
 * first argument Sheets would touch — enough to tell ours from the template's,
 * which is the distinction that matters.
 */
function sameFormula(got, want) {
  var a = String(got || '').replace(/\s+/g, '').toUpperCase();
  var b = String(want || '').replace(/\s+/g, '').toUpperCase();
  if (!a) return false;
  if (a.indexOf('#REF!') !== -1) return false;
  return a.slice(0, 20) === b.slice(0, 20);
}


/**
 * How many data rows each lane actually has, counted on the SKU column.
 *
 * Not getLastRow(): a previous run's formulas can sit thousands of rows below
 * the last SKU, and taking the sheet's word for it is what wrote 5,734 rows of
 * decisions onto a lane with 491 products.
 */
function laneRowCounts(planner, cfg) {
  var out = {};
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach(function (k) {
    var sh = sheetByName(planner, cfg.TABS[k]);
    out[k] = sh && isGridSheet(sh) ? laneRowCount(sh, k, cfg) : 0;
  });
  return out;
}

/** How far a run of blank SKUs may go before the lane is judged finished. */
var LANE_BLANK_RUN = 25;

/**
 * The lane's data rows: from the first, up to the last SKU before a long run
 * of blanks.
 *
 * "Last non-blank cell in the column" is the obvious reading and the wrong one.
 * One stray value left far below the data — a note, a leftover formula, a
 * pasted cell — stretches the lane to meet it, and every row in between gets a
 * full set of transfer formulas computing on nothing. A lane's SKU list is
 * contiguous, so a couple of dozen blanks in a row is the end of it.
 */
function laneRowCount(sheet, laneKey, cfg) {
  return countDataRows(sheet, cfg.COLS[laneKey].NAME,
    cfg.LAYOUT.LANE_FIRST_DATA_ROW);
}

/**
 * Data rows in a tab, counted on one column: from `first` to the last value
 * before a run of `LANE_BLANK_RUN` blanks.
 *
 * Used on the planner's lane tabs and on the IMS tabs feeding them, because
 * both lie in the same way. The IMS `US TO Tactical > AWD` tab reports its
 * last row as 5741 against 491 SKUs — the rows below carry stray formulas —
 * so anything measuring it with getLastRow() copies five thousand empty rows
 * and then calculates on them.
 */
function countDataRows(sheet, col0, first) {
  var last = sheet.getLastRow();
  if (last < first) return 0;

  var vals = sheet.getRange(first, col0 + 1, last - first + 1, 1).getValues();
  var lastSeen = 0;
  var blanks = 0;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i][0];
    if (String(v === null || v === undefined ? '' : v).trim()) {
      lastSeen = i + 1;
      blanks = 0;
    } else if (++blanks >= LANE_BLANK_RUN && lastSeen) {
      break;
    }
  }
  return lastSeen;
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
  var counts = rowCounts || {};
  return ['AWD_TO_FBA', 'TAC_TO_FBA', 'TAC_TO_AWD'].map(function (k) {
    return writeLaneFormulas(sheetByName(planner, cfg.TABS[k]), k,
      counts[k] || 0, cfg);
  });
}

/**
 * A lane that quietly received no formulas is worse than one that failed.
 *
 * On 09-09 Tactical > FBA came out of the run with its headers written and not
 * one calculated cell underneath, so the residual lane proposed nothing all
 * week and looked settled rather than broken. The run says so now.
 */
function formulaFailures(results) {
  return (results || []).filter(function (r) { return !r.ok; });
}

/**
 * How far each lane's formulas should run, preferring what the refresh just
 * pasted over what the sheet appears to hold.
 *
 * `refreshLane()` returns the row count it copied out of the IMS, which is the
 * one number in the run that is known rather than inferred. Falls back to
 * scanning the tab when the refresh was skipped or a lane failed.
 */
function refreshedRowCounts(refreshed, planner, cfg) {
  var out = laneRowCounts(planner, cfg);
  if (!refreshed) return out;
  var keys = ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'];
  refreshed.forEach(function (r, i) {
    if (r && r.ok && r.rows > 0) out[keys[i]] = r.rows;
  });
  return out;
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

// ------------------------------------------------------------- output tabs

/**
 * The pick lists and CSV tabs, as formulas rather than pasted rows.
 *
 * They used to be written as values, which made them a photograph of the
 * moment the plan was built. Change a case count on a lane afterwards — which
 * is the whole point of proposing rather than deciding — and the pick list you
 * actually type from still showed the old number.
 *
 * Each output column is its own `SORT(FILTER(...))` over the lane, filtered on
 * "cases > 0" and sorted on days of cover at the destination. Every column
 * uses the same filter and the same sort key, so the rows stay aligned; edit a
 * case count, or type a quantity onto a SKU the plan skipped, and the row
 * appears here on its own.
 *
 * Written without `{}` array literals or QUERY on purpose: the array
 * separator is locale-dependent, and a sheet opened outside the US would break
 * silently.
 */
function writeOutputFormulas(planner, cfg, rowsByLane) {
  var out = [];
  var stamp = plannerDate(planner.getName()) || new Date();
  var date = 'DATE(' + stamp.getFullYear() + ',' + (stamp.getMonth() + 1) + ','
    + stamp.getDate() + ')';

  function lane(laneKey) {
    var rows = rowsByLane[laneKey] || 0;
    var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
    return {
      key: laneKey,
      first: first,
      // A little headroom past the data, so a SKU typed onto the bottom of a
      // lane by hand still reaches the pick list.
      last: first + Math.max(rows, 1) - 1 + 200,
      col: function (col0) {
        var L = colLetter(col0);
        return quoteTab(cfg.TABS[laneKey]) + '!$' + L + '$' + this.first
          + ':$' + L + '$' + this.last;
      },
    };
  }

  /** Rows on this lane with something to send. */
  function sending(l, casesCol) {
    return 'ARRAYFORMULA(N(' + l.col(casesCol) + ')>0)';
  }

  /** One output column: the lane column, filtered and sorted by urgency. */
  function pick(l, col0, cond, sortCol) {
    return '=IFERROR(SORT(FILTER(' + l.col(col0) + ',' + cond + '),FILTER('
      + l.col(sortCol) + ',' + cond + '),TRUE),"")';
  }

  /** The same rows, run through a lookup — Amazon SKU, or the LTF comment. */
  function lookup(l, nameCol, cond, sortCol, range, index) {
    return '=IFERROR(ARRAYFORMULA(IFERROR(VLOOKUP(SORT(FILTER('
      + l.col(nameCol) + ',' + cond + '),FILTER(' + l.col(sortCol) + ','
      + cond + '),TRUE),' + range + ',' + index + ',FALSE),"")),"")';
  }

  /** A constant, repeated once per picked row and no further. */
  function constant(l, nameCol, cond, sortCol, value) {
    return '=IFERROR(ARRAYFORMULA(IF(LEN(SORT(FILTER(' + l.col(nameCol) + ','
      + cond + '),FILTER(' + l.col(sortCol) + ',' + cond + '),TRUE))>0,'
      + value + ',"")),"")';
  }

  var products = quoteTab(cfg.TABS.PRODUCTS) + '!$A:$B';
  var ltf = quoteTab(cfg.TABS.LTF) + '!$B:$Q';

  function emit(tabName, headerRow, formulas) {
    var sh = sheetByName(planner, tabName);
    if (!sh || !isGridSheet(sh)) {
      out.push({ tab: tabName, ok: false, note: 'no such tab' });
      return;
    }
    // Same trap as the lanes: a filter here would silently swallow the write.
    unhideForWriting(sh);

    // Everything under the header is regenerated, so last week's rows cannot
    // survive underneath this week's spill.
    var below = sh.getMaxRows() - headerRow;
    if (below > 0) {
      var stale = sh.getRange(headerRow + 1, 1, below,
        Math.max(sh.getMaxColumns(), formulas.length));
      stale.clearContent();
      stale.setBackground(null);
    }
    formulas.forEach(function (f, i) {
      if (f) sh.getRange(headerRow + 1, i + 1).setFormula(f);
    });
    out.push({ tab: tabName, ok: true, columns: formulas.filter(String).length });
  }

  var H = cfg.LAYOUT.SUMMARY_HEADER_ROW;
  var CH = cfg.LAYOUT.CSV_HEADER_ROW;

  // ---- Tactical > AWD -----------------------------------------------------
  var A = cfg.COLS.TAC_TO_AWD;
  var la = lane('TAC_TO_AWD');
  var aCond = sending(la, A.CASES_OUT);
  emit(cfg.TABS.SUMMARY_TAC_AWD, H, [
    pick(la, A.NAME, aCond, A.AWD_DOI),
    pick(la, A.CASE_QTY, aCond, A.AWD_DOI),
    pick(la, A.UNITS_OUT, aCond, A.AWD_DOI),
    lookup(la, A.NAME, aCond, A.AWD_DOI, products, 2),
    pick(la, A.CASES_OUT, aCond, A.AWD_DOI),
    lookup(la, A.NAME, aCond, A.AWD_DOI, ltf, 16),
  ]);
  emit(cfg.TABS.CSV_TAC_AWD, CH, [
    '',
    constant(la, A.NAME, aCond, A.AWD_DOI, date),
    constant(la, A.NAME, aCond, A.AWD_DOI,
      '"' + cfg.OUTPUT.SHIP_METHOD_TAC_AWD + '"'),
    pick(la, A.NAME, aCond, A.AWD_DOI),
    pick(la, A.UNITS_OUT, aCond, A.AWD_DOI),
    '',
  ]);

  // ---- AWD > FBA ----------------------------------------------------------
  var F = cfg.COLS.AWD_TO_FBA;
  var lf = lane('AWD_TO_FBA');
  var fCond = sending(lf, F.CASES_OUT);
  emit(cfg.TABS.SUMMARY_AWD_FBA, H, [
    pick(lf, F.NAME, fCond, F.AMZ_DOI),
    pick(lf, F.CASE_QTY, fCond, F.AMZ_DOI),
    pick(lf, F.UNITS_OUT, fCond, F.AMZ_DOI),
    pick(lf, F.CASES_OUT, fCond, F.AMZ_DOI),
    lookup(lf, F.NAME, fCond, F.AMZ_DOI, ltf, 16),
  ]);

  // ---- Tactical > FBA -----------------------------------------------------
  var T = cfg.COLS.TAC_TO_FBA;
  var lt = lane('TAC_TO_FBA');
  var tCond = sending(lt, T.CASES_OUT);
  emit(cfg.TABS.SUMMARY_TAC_FBA, H, [
    pick(lt, T.NAME, tCond, T.AMZ_DOI),
    pick(lt, T.CASE_QTY, tCond, T.AMZ_DOI),
    pick(lt, T.UNITS_OUT, tCond, T.AMZ_DOI),
    lookup(lt, T.NAME, tCond, T.AMZ_DOI, products, 2),
    pick(lt, T.CASES_OUT, tCond, T.AMZ_DOI),
  ]);
  emit(cfg.TABS.CSV_TAC_FBA, CH, [
    '',
    constant(lt, T.NAME, tCond, T.AMZ_DOI, date),
    constant(lt, T.NAME, tCond, T.AMZ_DOI,
      '"' + cfg.OUTPUT.SHIP_METHOD_TAC_FBA + '"'),
    pick(lt, T.NAME, tCond, T.AMZ_DOI),
    pick(lt, T.UNITS_OUT, tCond, T.AMZ_DOI),
    '',
  ]);

  // ---- CSV to Tactical ----------------------------------------------------
  //
  // The pick instruction for the warehouse, so the last column is the whole
  // draw on Tactical this run — both lanes, not just the palletised one.
  var drawn = 'ARRAYFORMULA((N(' + la.col(A.TAC_AVAILABLE) + ')>0)+(N('
    + la.col(A.CASES_OUT) + ')>0)>0)';
  var byName = 'FILTER(' + la.col(A.NAME) + ',' + drawn + ')';
  var fromFba = 'IFERROR(VLOOKUP(SORT(' + byName + ',' + byName + ',TRUE),'
    + quoteTab(cfg.TABS.TAC_TO_FBA) + '!$' + colLetter(T.NAME) + ':$'
    + colLetter(T.CASES_OUT) + ',' + (T.CASES_OUT - T.NAME + 1) + ',FALSE),0)';
  emit(cfg.TABS.CSV_TO_TACTICAL, CH, [
    '=IFERROR(SORT(' + byName + ',' + byName + ',TRUE),"")',
    '=IFERROR(SORT(FILTER(' + la.col(A.AVAILABLE_CASES) + ',' + drawn + '),'
      + byName + ',TRUE),"")',
    '=IFERROR(SORT(FILTER(' + la.col(A.TAC_AVAILABLE) + ',' + drawn + '),'
      + byName + ',TRUE),"")',
    '=IFERROR(ARRAYFORMULA(N(SORT(FILTER(' + la.col(A.CASES_OUT) + ',' + drawn
      + '),' + byName + ',TRUE))+N(' + fromFba + ')),"")',
  ]);

  return out;
}

/**
 * How many rows each lane's formulas cover, from the results of writing them.
 * Falls back to the rows the reader saw, so the output tabs still reach the
 * bottom of the data when the formula layer was skipped.
 */
function laneRowsWritten(input) {
  var out = { TAC_TO_AWD: 0, AWD_TO_FBA: 0, TAC_TO_FBA: 0 };
  (input.meta.formulas || []).forEach(function (r) {
    if (r && r.lane && r.rows > 0) out[r.lane] = r.rows;
  });
  if (!out.TAC_TO_AWD) out.TAC_TO_AWD = input.tacToAwd.length;
  if (!out.AWD_TO_FBA) out.AWD_TO_FBA = input.awdToFba.length;
  if (!out.TAC_TO_FBA) out.TAC_TO_FBA = input.tacToFba.length;
  return out;
}

/**
 * Make every row on a sheet writable: drop any filter, show any hidden row.
 *
 * Returns what was removed, so the run can say so, or null if there was
 * nothing in the way.
 *
 * This is the fix for the longest-running fault in this project. Apps Script's
 * setValues() and setFormulas() skip rows that a filter has hidden. No error,
 * no partial-write warning — the cells simply keep whatever was in them, and
 * every check downstream reads a number that was never recalculated.
 */
function unhideForWriting(sheet) {
  var note = null;
  try {
    var filter = sheet.getFilter();
    if (filter) {
      var where = filter.getRange().getA1Notation();
      filter.remove();
      note = 'filter over ' + where;
    }
  } catch (e) {
    // Older runtimes have no getFilter(); nothing to clear there.
  }
  try {
    var rows = sheet.getMaxRows();
    if (rows > 0) sheet.showRows(1, rows);
  } catch (e) {
    // Not fatal: a sheet that will not unhide still gets written to below.
  }
  return note;
}
