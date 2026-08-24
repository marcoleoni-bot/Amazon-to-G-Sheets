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

  tintLaneUrgency(input.sheets.tacToAwd, input.tacToAwd, cfg.COLS.TAC_TO_AWD.AWD_DOI, cfg);
  tintLaneUrgency(input.sheets.awdToFba, input.awdToFba, cfg.COLS.AWD_TO_FBA.AMZ_DOI, cfg);
  tintLaneUrgency(input.sheets.tacToFba, input.tacToFba, cfg.COLS.TAC_TO_FBA.AMZ_DOI, cfg);

  // Column Y is a formula when the formula layer is on, and writing a value
  // over it would strand the number pass 1 reads at whatever it was this run.
  if (cfg.OUTPUT.WRITE_RECOMPUTED_Y && !cfg.FORMULAS.ENABLED) {
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

  // With formulas on, the quantity and the units belong to the sheet. Writing
  // a value over the formula would replace the live calculation with a dead
  // number the moment the reasons are written — the exact thing the formula
  // layer exists to stop.
  if (!cfg.FORMULAS.ENABLED) {
    sheet.getRange(first, C.CASES_OUT + 1, span, 1).setValues(cases);
    sheet.getRange(first, C.UNITS_OUT + 1, span, 1).setFormulas(units);
  }

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

/**
 * Ramp the destination-DOI column red to green, so scanning the lane shows
 * what is close to running out before you read a single number.
 */
function tintLaneUrgency(sheet, rows, doiCol, cfg) {
  if (!sheet || !rows.length) return;
  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var span = rows[rows.length - 1].rowIndex - first + 1;
  var fills = blankColumn(span, null);
  rows.forEach(function (r) {
    fills[r.rowIndex - first][0] = urgencyColour(urgencyOf(r), cfg);
  });
  sheet.getRange(first, doiCol + 1, span, 1).setBackgrounds(fills);
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

/**
 * Days of cover at the destination — the number that decides how urgent a row
 * is. FBA for the two lanes that end there, AWD for Tactical > AWD.
 */
function urgencyOf(row) {
  if (row.amzDoi !== undefined && row.amzDoi !== null) return row.amzDoi;
  if (row.awdDoi !== undefined && row.awdDoi !== null) return row.awdDoi;
  return 999999;
}

/** The first band the cover falls into. */
function urgencyColour(doi, cfg) {
  var bands = cfg.URGENCY.BANDS;
  for (var i = 0; i < bands.length; i++) {
    if (doi <= bands[i].upTo) return bands[i].colour;
  }
  return bands[bands.length - 1].colour;
}

/**
 * Accepted rows for a lane: cases > 0, most urgent first.
 *
 * Sorted on days of cover rather than SKU, because the question when reading
 * down a pick list is "what runs out first", and alphabetical order answers a
 * question nobody asked.
 */
function accepted(rows, decisions, cfg) {
  var out = [];
  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d || d.cases <= 0) return;
    if (!cfg.OUTPUT.LTF_IN_SUMMARIES && d.flags.indexOf('LTF_FLAG') !== -1) return;
    out.push({ row: r, dec: d, urgency: urgencyOf(r) });
  });
  out.sort(function (a, b) {
    if (cfg.URGENCY.SORT_BY_URGENCY && a.urgency !== b.urgency) {
      return a.urgency - b.urgency;
    }
    return a.row.sku < b.row.sku ? -1 : (a.row.sku > b.row.sku ? 1 : 0);
  });
  return out;
}

function amazonSkuFor(input, sku) {
  var p = input.products[normSku(sku)];
  return p ? p.amazonSku : '';
}

/** Paint each written summary row by how close it is to running out. */
function tintByUrgency(sheet, headerRow, picks, width, cfg) {
  if (!sheet || !picks.length || !cfg.URGENCY.TINT_SUMMARIES) return;
  var fills = picks.map(function (p) {
    var c = urgencyColour(p.urgency, cfg);
    var row = [];
    for (var i = 0; i < width; i++) row.push(c);
    return row;
  });
  sheet.getRange(headerRow + 1, 1, picks.length, width).setBackgrounds(fills);
}

/** Replace everything below the header row, so nothing survives from last week. */
function replaceBelowHeader(sheet, headerRow, rows, width) {
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last > headerRow) {
    // Formats as well as content: an urgency tint left on a row that no longer
    // has a SKU in it reads as a live, urgent line.
    var stale = sheet.getRange(headerRow + 1, 1, last - headerRow,
      Math.max(sheet.getLastColumn(), width));
    stale.clearContent();
    stale.setBackground(null);
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
  var aSheet = sheetByName(planner, cfg.TABS.SUMMARY_TAC_AWD);
  replaceBelowHeader(aSheet, H, a, 6);
  tintByUrgency(aSheet, H, accepted(input.tacToAwd, plan.tacToAwd, cfg), 6, cfg);

  // AWD > FBA: SKU | Case qty | Units | CASES | LTF.
  // This one is typed straight into Seller Central, so it stays this narrow.
  var f = accepted(input.awdToFba, plan.awdToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      x.dec.cases, x.dec.ltfComment || ''];
  });
  var fSheet = sheetByName(planner, cfg.TABS.SUMMARY_AWD_FBA);
  replaceBelowHeader(fSheet, H, f, 5);
  tintByUrgency(fSheet, H, accepted(input.awdToFba, plan.awdToFba, cfg), 5, cfg);

  // Tactical > FBA: name | Case QTY | units | Amazon SKU | Cases
  var t = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      amazonSkuFor(input, x.row.sku), x.dec.cases];
  });
  var tSheet = sheetByName(planner, cfg.TABS.SUMMARY_TAC_FBA);
  replaceBelowHeader(tSheet, H, t, 5);
  tintByUrgency(tSheet, H, accepted(input.tacToFba, plan.tacToFba, cfg), 5, cfg);
}

// ----------------------------------------------------------------- CSV tabs

/**
 * externalid and FBA_iD stay blank: the TO number and the shipment ID do not
 * exist until the transfer has been raised, and are pasted in afterwards.
 */
function writeCsvTabs(planner, input, plan, cfg) {
  var H = cfg.LAYOUT.CSV_HEADER_ROW;

  // The trandate is what tells a later reader whether these rows belong to
  // this run or were carried in with the file — a CSV tab dated to another
  // day means nothing shipped from Tactical that week. So it is stamped with
  // the planner's own date, not with today's.
  var stamp = plannerDate(planner.getName()) || new Date();

  var awd = accepted(input.tacToAwd, plan.tacToAwd, cfg).map(function (x) {
    return ['', stamp, cfg.OUTPUT.SHIP_METHOD_TAC_AWD, x.row.sku,
      x.dec.cases * x.row.caseQty, ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TAC_AWD), H, awd, 6);

  var fba = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return ['', stamp, cfg.OUTPUT.SHIP_METHOD_TAC_FBA, x.row.sku,
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
  var v = plan.verdicts;

  // The verdict goes first. "Do I raise this TO today, and why" is the whole
  // question, and it should not need 491 rows of reading to answer.
  var lines = [
    ['US transfer order plan', ''],
    ['', ''],
    ['RAISE THIS ORDER?', ''],
    [v.tacToAwd.lane, (v.tacToAwd.raise ? 'YES — ' : 'NO — ') + v.tacToAwd.why],
    [v.awdToFba.lane, (v.awdToFba.raise ? 'YES — ' : 'NO — ') + v.awdToFba.why],
    [v.tacToFba.lane, (v.tacToFba.raise ? 'YES — ' : 'NO — ') + v.tacToFba.why],
    ['', ''],
    ['Built', Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd HH:mm z')],
    ['Snapshot', c.snapshot || 'live'],
    ['Lane values from', input.meta.refreshed
      ? input.meta.refreshed.map(function (r) {
        return r.ok ? r.from + ' (' + r.rows + ' rows)' : r.lane + ' NOT REFRESHED — ' + r.note;
      }).join('; ')
      : input.meta.laneSource + ' (not refreshed this run)'],
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
  sh.setColumnWidth(2, 560);

  // Colour the three verdicts so a held lane cannot be mistaken for a live one.
  var verdictAt = labelRow(lines, 'RAISE THIS ORDER?');
  if (verdictAt) {
    sh.getRange(verdictAt, 1, 1, 2).setFontWeight('bold')
      .setBackground(cfg.COLOURS.HEADER);
    [v.tacToAwd, v.awdToFba, v.tacToFba].forEach(function (lane, i) {
      sh.getRange(verdictAt + 1 + i, 1, 1, 2)
        .setBackground(lane.raise ? cfg.COLOURS.PASS_2 : cfg.COLOURS.PALLET_FILL);
    });
  }

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
