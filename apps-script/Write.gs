/**
 * Everything that lands in the sheet: quantities, reason codes, colours, the
 * summary tabs, the CSV tabs and the run header.
 *
 * The units column is written as a formula (=N8*O8) rather than a number. When
 * Marco overrides a case count — which is the point of proposing rather than
 * deciding — the units follow him instead of silently disagreeing.
 */

function writePlan(planner, input, plan, cfg, ctx) {
  writeLane(input.sheets.tacToAwd, input.tacToAwd, plan.tacToAwd,
    cfg.COLS.TAC_TO_AWD, cfg, 'Reason');
  writeLane(input.sheets.awdToFba, input.awdToFba, plan.awdToFba,
    cfg.COLS.AWD_TO_FBA, cfg, 'Reason');
  writeLane(input.sheets.tacToFba, input.tacToFba, plan.tacToFba,
    cfg.COLS.TAC_TO_FBA, cfg, 'Reason');

  if (cfg.OUTPUT.WRITE_RECOMPUTED_Y) {
    writeAvailableOnlyDoi(input.sheets.awdToFba, input.awdToFba, cfg);
  }
  if (cfg.OUTPUT.WRITE_SUMMARIES) {
    writeSummaries(planner, input, plan, cfg);
  }
  if (cfg.OUTPUT.WRITE_CSV_TABS) {
    writeCsvTabs(planner, input, plan, cfg);
  }
  writeRunHeader(planner, input, plan, cfg, ctx);
}

// --------------------------------------------------------------------- lanes

/**
 * The reason column is one past the lane's last used column, which on
 * Tactical > FBA is column Y — one beyond the 24 the tab actually has. Asking
 * for a range outside the grid throws, so widen the sheet first.
 */
function ensureColumns(sheet, count) {
  var have = sheet.getMaxColumns();
  if (have < count) sheet.insertColumnsAfter(have, count - have);
}

function writeLane(sheet, rows, decisions, C, cfg, reasonHeader) {
  if (!sheet || !rows.length) return;
  ensureColumns(sheet, C.REASON + 1);

  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var last = rows[rows.length - 1].rowIndex;
  var span = last - first + 1;

  var cases = blankColumn(span);
  var units = blankColumn(span);
  var reason = blankColumn(span);
  var fills = blankColumn(span, null);

  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d) return;
    var at = r.rowIndex - first;
    var qty = d.cases > 0 ? d.cases : 0;

    cases[at][0] = qty;
    units[at][0] = '=' + colLetter(C.CASES_OUT) + r.rowIndex
      + '*' + colLetter(C.CASE_QTY) + r.rowIndex;
    reason[at][0] = reasonText(d, r.caseQty);
    fills[at][0] = colourFor(d, cfg);
  });

  sheet.getRange(first, C.CASES_OUT + 1, span, 1).setValues(cases);
  sheet.getRange(first, C.UNITS_OUT + 1, span, 1).setFormulas(units);

  var reasonRange = sheet.getRange(first, C.REASON + 1, span, 1);
  reasonRange.setValues(reason);
  reasonRange.setBackgrounds(fills);
  sheet.getRange(first, C.CASES_OUT + 1, span, 1).setBackgrounds(fills);

  var head = sheet.getRange(cfg.LAYOUT.LANE_HEADER_ROW, C.REASON + 1);
  head.setValue(reasonHeader);
  head.setBackground(cfg.COLOURS.HEADER);
  head.setFontWeight('bold');

  // A floor breach is rare enough to deserve something you cannot scroll past.
  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d || d.flags.indexOf('FLOOR_BREACH') === -1) return;
    sheet.getRange(r.rowIndex, C.CASES_OUT + 1, 1, 2)
      .setBorder(true, true, true, true, false, false,
        cfg.COLOURS.FLOOR_BREACH_BORDER, SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
}

/** §4 — column Y recomputed on order_plan_rate, so the sheet shows what the rule used. */
function writeAvailableOnlyDoi(sheet, rows, cfg) {
  if (!sheet || !rows.length) return;
  var C = cfg.COLS.AWD_TO_FBA;
  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var span = rows[rows.length - 1].rowIndex - first + 1;
  var col = blankColumn(span);
  rows.forEach(function (r) {
    col[r.rowIndex - first][0] = r.rate > 0 ? r.amzFulfillable / r.rate : '';
  });
  sheet.getRange(first, C.AVAILABLE_ONLY_DOI + 1, span, 1).setValues(col);
}

function colourFor(d, cfg) {
  if (d.flags.indexOf('LTF_FLAG') !== -1) return cfg.COLOURS.LTF;
  if (d.flags.indexOf('NEEDS_REVIEW') !== -1) return cfg.COLOURS.NEEDS_REVIEW;
  if (d.pass === 'PALLET_FILL') return cfg.COLOURS.PALLET_FILL;
  if (d.pass === 'PASS_1') return cfg.COLOURS.PASS_1;
  if (d.pass === 'PASS_2') return cfg.COLOURS.PASS_2;
  return cfg.COLOURS.PASS_3;
}

function blankColumn(n, value) {
  var v = value === undefined ? '' : value;
  var out = [];
  for (var i = 0; i < n; i++) out.push([v]);
  return out;
}

function colLetter(zeroBased) {
  var s = '';
  var i = zeroBased + 1;
  while (i > 0) {
    var r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// ----------------------------------------------------------------- summaries

/** Accepted rows for a lane: cases > 0, sorted by SKU so it reads down cleanly. */
function accepted(rows, decisions, cfg) {
  var out = [];
  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d || d.cases <= 0) return;
    if (!cfg.OUTPUT.LTF_IN_SUMMARIES && d.flags.indexOf('LTF_FLAG') !== -1) return;
    out.push({ row: r, dec: d });
  });
  out.sort(function (a, b) {
    return a.row.sku < b.row.sku ? -1 : (a.row.sku > b.row.sku ? 1 : 0);
  });
  return out;
}

function amazonSkuFor(input, sku) {
  var p = input.products[normSku(sku)];
  return p ? p.amazonSku : '';
}

/** Replace everything below the header row, so nothing survives from last week. */
function replaceBelowHeader(sheet, headerRow, rows, width) {
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last > headerRow) {
    sheet.getRange(headerRow + 1, 1, last - headerRow,
      Math.max(sheet.getLastColumn(), width)).clearContent();
  }
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, width).setValues(rows);
  }
}

function writeSummaries(planner, input, plan, cfg) {
  var H = cfg.LAYOUT.SUMMARY_HEADER_ROW;

  // Tactical > AWD: name | Case QTY | units | Amazon SKU | Cases | LTF
  var a = accepted(input.tacToAwd, plan.tacToAwd, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      amazonSkuFor(input, x.row.sku), x.dec.cases, x.dec.ltfComment || ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.SUMMARY_TAC_AWD), H, a, 6);

  // AWD > FBA: SKU | Case qty | Units | CASES | LTF.
  // This one is typed straight into Seller Central, so it stays this narrow.
  var f = accepted(input.awdToFba, plan.awdToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      x.dec.cases, x.dec.ltfComment || ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.SUMMARY_AWD_FBA), H, f, 5);

  // Tactical > FBA: name | Case QTY | units | Amazon SKU | Cases
  var t = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      amazonSkuFor(input, x.row.sku), x.dec.cases];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.SUMMARY_TAC_FBA), H, t, 5);
}

// ----------------------------------------------------------------- CSV tabs

/**
 * externalid and FBA_iD stay blank: the TO number and the shipment ID do not
 * exist until the transfer has been raised, and are pasted in afterwards.
 */
function writeCsvTabs(planner, input, plan, cfg) {
  var H = cfg.LAYOUT.CSV_HEADER_ROW;
  var today = new Date();

  var awd = accepted(input.tacToAwd, plan.tacToAwd, cfg).map(function (x) {
    return ['', today, cfg.OUTPUT.SHIP_METHOD_TAC_AWD, x.row.sku,
      x.dec.cases * x.row.caseQty, ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TAC_AWD), H, awd, 6);

  var fba = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return ['', today, cfg.OUTPUT.SHIP_METHOD_TAC_FBA, x.row.sku,
      x.dec.cases * x.row.caseQty, ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TAC_FBA), H, fba, 6);

  // CSV to Tactical is the pick instruction, so CartonToAmazon is the whole
  // draw on Tactical this run — both lanes, not just the AWD one.
  var fbaCasesBySku = {};
  input.tacToFba.forEach(function (r, i) {
    var d = plan.tacToFba[i];
    if (d && d.cases > 0) {
      fbaCasesBySku[normSku(r.sku)] = (fbaCasesBySku[normSku(r.sku)] || 0) + d.cases;
    }
  });

  var tactical = [];
  input.tacToAwd.forEach(function (r, i) {
    var d = plan.tacToAwd[i];
    var toAmazon = (d && d.cases > 0 ? d.cases : 0)
      + (fbaCasesBySku[normSku(r.sku)] || 0);
    if (r.tacAvailableUnits <= 0 && toAmazon === 0) return;
    tactical.push([r.sku, r.availableCases, r.tacAvailableUnits, toAmazon]);
  });
  tactical.sort(function (x, y) { return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0); });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TO_TACTICAL), H, tactical, 4);
}

// --------------------------------------------------------------- run header

/** What was run, against what, with which dials — on its own tab. */
function writeRunHeader(planner, input, plan, cfg, ctx) {
  var name = cfg.TABS.RUN_HEADER;
  var sh = sheetByName(planner, name);
  if (!sh) sh = planner.insertSheet(name);
  sh.clear();

  var c = ctx || {};
  var pallet = plan.pallet;
  var lines = [
    ['US transfer order plan', ''],
    ['Built', Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd HH:mm z')],
    ['Snapshot', c.snapshot || 'live'],
    ['Lane values from', input.meta.laneSource],
    ['Tactical floor from', input.meta.minUnitsSource],
    ['', ''],
    ['DSS — Tactical > AWD', dssFor(cfg, 'TAC_TO_AWD')],
    ['DSS — AWD > FBA', dssFor(cfg, 'AWD_TO_FBA')],
    ['DSS — Tactical > FBA', dssFor(cfg, 'TAC_TO_FBA')],
    ['Priority (B2B / Critical) DOI', cfg.RULES.PRIORITY_DOI],
    ['Pass 1 gate', 'reserved/fulfillable > ' + cfg.RULES.PASS1_RESERVED_RATIO
      + ', available-only DOI < ' + cfg.RULES.PASS1_AVAILABLE_DOI],
    ['Pass 1 caps', cfg.RULES.PASS1_DOI_CAP + ' DOI, single case to '
      + cfg.RULES.PASS1_SINGLE_CASE_CAP],
    ['Contention threshold', 'FBA DOI < ' + cfg.RULES.FBA_DOI_CONTENTION
      + ' serves Tactical > FBA first'],
    ['Pallet minimum', cfg.RULES.PALLET_MIN_CASES + ' cases'],
    ['Pallet fill ceiling', 'AWD DOI ' + cfg.RULES.PALLET_FILL_MAX_AWD_DOI
      + ', max ' + cfg.RULES.PALLET_FILL_MAX_CASES_PER_SKU + ' cases/SKU'],
    ['', ''],
    ['Tactical > AWD', plan.totals.tacToAwdCases + ' cases'],
    ['AWD > FBA', plan.totals.awdToFbaCases + ' cases'],
    ['Tactical > FBA', plan.totals.tacToFbaCases + ' cases'],
    ['', ''],
    ['Pallet: demand-driven', pallet.demandCases + ' cases'],
    ['Pallet: filled forward', pallet.filledCases + ' cases'],
    ['Pallet: status', palletStatus(pallet)],
    ['', ''],
    ['Rows needing review', plan.totals.needsReview],
    ['Rows flagged LTF', plan.totals.ltfHeld],
    ['Tactical floor breaches', plan.totals.floorBreaches],
    ['SKUs on CRITICAL', input.meta.criticalCount],
    ['SKUs on LTF', input.meta.ltfCount],
  ];

  sh.getRange(1, 1, lines.length, 2).setValues(lines);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground(cfg.COLOURS.HEADER);
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 460);

  // §6.1: an under-full pallet is surfaced here rather than shipped quietly.
  if (pallet.shortfall > 0) {
    var at = labelRow(lines, 'Pallet: status');
    if (at) sh.getRange(at, 2).setBackground(cfg.COLOURS.NEEDS_REVIEW);
  }
  return sh;
}

/** 1-based row of a label in the run header, or 0 if it moved. */
function labelRow(lines, label) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i][0] === label) return i + 1;
  }
  return 0;
}

function palletStatus(p) {
  if (p.skipped) return 'no demand — no shipment suggested';
  if (p.shortfall > 0) {
    return 'SHORT by ' + p.shortfall + ' cases — filler pool exhausted at '
      + (p.demandCases + p.filledCases) + ' of ' + p.target;
  }
  if (p.filledCases > 0) {
    return 'topped up to ' + (p.demandCases + p.filledCases) + ' cases';
  }
  return 'met by demand (' + p.demandCases + ' cases)';
}
