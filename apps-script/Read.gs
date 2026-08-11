/**
 * Pulls every input the rules need into one plain object per lane.
 *
 * Two habits here are deliberate:
 *
 *  - Tabs are resolved tolerantly (trimmed, case-insensitive). One of the real
 *    tab names ends in a space; a lookup that depends on reproducing that
 *    exactly is a trap, and the failure it produces ("no such sheet") tells you
 *    nothing. On a miss the error lists the tabs that do exist.
 *
 *  - Critical and B2B come from their own tabs, not from the MATCH formulas
 *    sitting in the lane columns, so a stale or broken formula cannot quietly
 *    change a decision.
 */

/** Find a sheet by name, ignoring case and surrounding space. */
function sheetByName(ss, name) {
  if (!name) return null;
  var want = String(name).trim().toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === want) return sheets[i];
  }
  return null;
}

function requireSheet(ss, name, what) {
  var sh = sheetByName(ss, name);
  if (sh) return sh;
  var have = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; });
  throw new Error('Cannot find the ' + what + ' tab "' + name + '" in "'
    + ss.getName() + '".\n  Tabs present: ' + have.join(', '));
}

/** Values from `firstRow` to the last row with content, or [] if none. */
function readBlock(sheet, firstRow) {
  var last = sheet.getLastRow();
  if (last < firstRow) return [];
  var width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(firstRow, 1, last - firstRow + 1, width).getValues();
}

/**
 * A fresh copy's IMPORTRANGE/QUERY cells return "Loading..." for a moment, and
 * a script that reads through that writes decisions built on nothing. Wait for
 * the lane tabs to settle, and say so plainly if they never do.
 */
function waitForFormulas(ss, tabNames, timeoutSeconds) {
  var deadline = Date.now() + (timeoutSeconds || 120) * 1000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    var loading = false;
    for (var i = 0; i < tabNames.length && !loading; i++) {
      var sh = sheetByName(ss, tabNames[i]);
      if (!sh) continue;
      var vals = readBlock(sh, 1);
      for (var r = 0; r < vals.length && !loading; r++) {
        for (var c = 0; c < vals[r].length; c++) {
          if (vals[r][c] === 'Loading...') { loading = true; break; }
        }
      }
    }
    if (!loading) return true;
    Utilities.sleep(2000);
  }
  throw new Error('Lane tabs still showed "Loading..." after '
    + (timeoutSeconds || 120) + 's. The IMPORTRANGE feeding this planner has not '
    + 'settled — open the file, confirm access, and run again.');
}

// ------------------------------------------------------------- lookup tables

/** SKU -> { comment } for everything on the LTF tab in this market. */
function readLtf(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.LTF);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.LTF;
  readBlock(sh, cfg.LAYOUT.LTF_HEADER_ROW + 1).forEach(function (row) {
    var sku = normSku(row[C.SKU]);
    if (!sku) return;
    var market = String(row[C.MARKET] || '').trim().toUpperCase();
    if (market && market !== cfg.MARKET) return;
    out[sku] = { comment: String(row[C.COMMENT] || '').trim() };
  });
  return out;
}

/** The set of SKUs on the CRITICAL tab. */
function readCritical(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.CRITICAL);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.CRITICAL;
  readBlock(sh, cfg.LAYOUT.CRITICAL_HEADER_ROW + 1).forEach(function (row) {
    var sku = normSku(row[C.SKU]);
    if (sku) out[sku] = true;
  });
  return out;
}

/** name -> { amazonSku, caseQty, discontinued } from `Copy of Sheet1`. */
function readProducts(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.PRODUCTS);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.PRODUCTS;
  readBlock(sh, cfg.LAYOUT.PRODUCTS_HEADER_ROW + 1).forEach(function (row) {
    var name = normSku(row[C.NAME]);
    if (!name) return;
    out[name] = {
      amazonSku: String(row[C.AMAZON_SKU] || '').trim(),
      caseQty: num(row[C.CASE_QTY]),
      discontinued: String(row[C.DISCONTINUED] || '').trim().toUpperCase() === 'T',
    };
  });
  return out;
}

/**
 * The Tactical floor, read straight from its own workbook (§2).
 *
 * Returns { bySku, source }. When the tab is not configured or not readable the
 * caller falls back to the planner's own column B — which is the same number by
 * a longer route, but the run header has to say which was used.
 */
function readMinUnits(cfg) {
  var conf = cfg.MIN_UNITS;
  var missing = function (why) {
    return { bySku: {}, b2bSkus: {}, count: 0, source: 'planner column B (' + why + ')' };
  };
  if (!conf.TAB) return missing('MIN_UNITS.TAB not set');

  try {
    var ss = SpreadsheetApp.openById(cfg.SOURCES.MIN_UNITS_ID);
    var sh = requireSheet(ss, conf.TAB, 'minimum units');
    var all = readBlock(sh, 1);
    if (!all.length) throw new Error('tab is empty');

    // The planner reaches this data with VLOOKUP over A:E, which neither knows
    // nor cares whether row 1 is a header. Match that: only skip the first row
    // when it really does carry both header labels, so a tab with no header
    // does not quietly lose its first SKU.
    var header = all[0].map(function (h) {
      return String(h || '').trim().toLowerCase();
    });
    var skuCol = header.indexOf(String(conf.SKU_HEADER).toLowerCase());
    var unitsCol = header.indexOf(String(conf.UNITS_HEADER).toLowerCase());
    var labelled = skuCol !== -1 && unitsCol !== -1;
    if (!labelled) {
      skuCol = conf.SKU_COL;
      unitsCol = conf.UNITS_COL;
    }

    var bySku = {};
    var b2bSkus = {};
    var count = 0;
    (labelled ? all.slice(1) : all).forEach(function (row) {
      var sku = normSku(row[skuCol]);
      if (!sku) return;
      bySku[sku] = num(row[unitsCol]);
      b2bSkus[sku] = true;
      if (bySku[sku] > 0) count++;
    });

    return {
      bySku: bySku,
      b2bSkus: conf.TREAT_AS_B2B ? b2bSkus : {},
      count: count,
      source: ss.getName() + ' / ' + sh.getName() + ' — ' + count + ' floors',
    };
  } catch (e) {
    return missing('direct read failed: ' + e.message);
  }
}

// -------------------------------------------------------------------- lanes

function laneRows(ss, tabName, cfg, what) {
  var sh = requireSheet(ss, tabName, what);
  return {
    sheet: sh,
    values: readBlock(sh, cfg.LAYOUT.LANE_FIRST_DATA_ROW),
    firstRow: cfg.LAYOUT.LANE_FIRST_DATA_ROW,
  };
}

/** Rows with a name, in this market. Blank names end the lane. */
function usable(values, nameCol, mktCol, cfg) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var name = String(row[nameCol] || '').trim();
    if (!name) continue;
    var mkt = String(row[mktCol] || '').trim().toUpperCase();
    if (mkt && mkt !== cfg.MARKET) continue;
    out.push({ row: row, offset: i });
  }
  return out;
}

/**
 * Every input the decision layer needs, for one planner.
 *
 * `planner` is the workbook being written. When SOURCES.LANES_FROM is 'ims'
 * the lane values are taken from the IMS instead — same layout, same reader.
 */
function readPlanningInput(planner, cfg) {
  var ims = null;
  try {
    ims = SpreadsheetApp.openById(cfg.SOURCES.IMS_ID);
  } catch (e) {
    ims = null; // Not fatal: only the optional B2B tab lives there.
  }

  var laneSource = planner;
  var tabs = cfg.TABS;
  if (cfg.SOURCES.LANES_FROM === 'ims') {
    if (!ims) throw new Error('LANES_FROM is "ims" but the IMS could not be opened.');
    var t = cfg.SOURCES.IMS_LANE_TABS;
    if (!t.TAC_TO_AWD || !t.AWD_TO_FBA || !t.TAC_TO_FBA) {
      throw new Error('LANES_FROM is "ims" but SOURCES.IMS_LANE_TABS is not filled in.');
    }
    laneSource = ims;
    tabs = {
      TAC_TO_AWD: t.TAC_TO_AWD,
      AWD_TO_FBA: t.AWD_TO_FBA,
      TAC_TO_FBA: t.TAC_TO_FBA,
    };
  }

  waitForFormulas(laneSource,
    [tabs.TAC_TO_AWD, tabs.AWD_TO_FBA, tabs.TAC_TO_FBA], 120);

  var critical = readCritical(planner, cfg);
  var ltfIndex = readLtf(planner, cfg);
  var products = readProducts(planner, cfg);

  // The B2B tab and the Tactical floor are the same tab: the planner's column
  // B is VLOOKUP(name, 'B2B'!A:E, 5). One read serves both.
  var minUnits = readMinUnits(cfg);
  var b2bTab = minUnits.b2bSkus;

  function caseQtyFor(sku, cellValue) {
    var q = num(cellValue);
    if (q > 0) return q;
    var p = products[normSku(sku)];
    return p ? p.caseQty : 0;
  }

  function floorFor(sku, cellValue) {
    var k = normSku(sku);
    if (Object.prototype.hasOwnProperty.call(minUnits.bySku, k)) return minUnits.bySku[k];
    return num(cellValue);
  }

  function isB2b(sku, cellValue) {
    return bool(cellValue) || !!b2bTab[normSku(sku)];
  }

  // ---- Tactical > AWD ----------------------------------------------------
  var A = cfg.COLS.TAC_TO_AWD;
  var aLane = laneRows(laneSource, tabs.TAC_TO_AWD, cfg, 'Tactical > AWD');
  var tacToAwd = usable(aLane.values, A.NAME, A.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[A.NAME]).trim();
    return {
      rowIndex: aLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[A.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[A.ORDER_PLAN_RATE]),
      trueRate30: num(row[A.TRUE_RATE_30]),
      lifecycle: String(row[A.LIFECYCLE] || '').trim(),
      tacAvailableUnits: num(row[A.TAC_AVAILABLE]),
      availableCases: num(row[A.AVAILABLE_CASES]),
      wrDoi: num(row[A.WR_DOI]),
      awdQty: num(row[A.AWD_QTY]),
      awdInbound14: num(row[A.AWD_INBOUND_14]),
      awdDoi: num(row[A.AWD_DOI]),
      caseQty: caseQtyFor(sku, row[A.CASE_QTY]),
      minUnits: floorFor(sku, row[A.MIN_UNITS]),
      fbaDoi: num(row[A.FBA_DOI], null),
    };
  });

  // ---- AWD > FBA ---------------------------------------------------------
  var F = cfg.COLS.AWD_TO_FBA;
  var fLane = laneRows(laneSource, tabs.AWD_TO_FBA, cfg, 'AWD > FBA');
  var awdToFba = usable(fLane.values, F.NAME, F.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[F.NAME]).trim();
    return {
      rowIndex: fLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[F.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[F.ORDER_PLAN_RATE]),
      trueRate30: num(row[F.TRUE_RATE_30]),
      lifecycle: String(row[F.LIFECYCLE] || '').trim(),
      awdAvailableUnits: num(row[F.AWD_AVAILABLE]),
      availableCases: num(row[F.AVAILABLE_CASES]),
      awdDoi: num(row[F.AWD_DOI]),
      amzFulfillable: num(row[F.AMZ_FULFILLABLE]),
      amzReserved: num(row[F.AMZ_RESERVED]),
      amzInbound: num(row[F.AMZ_INBOUND]),
      amzTotal: num(row[F.AMZ_TOTAL]),
      amzDoi: num(row[F.AMZ_DOI]),
      caseQty: caseQtyFor(sku, row[F.CASE_QTY]),
    };
  });

  // ---- Tactical > FBA ----------------------------------------------------
  var T = cfg.COLS.TAC_TO_FBA;
  var tLane = laneRows(laneSource, tabs.TAC_TO_FBA, cfg, 'Tactical > FBA');
  var tacToFba = usable(tLane.values, T.NAME, T.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[T.NAME]).trim();
    return {
      rowIndex: tLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[T.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[T.ORDER_PLAN_RATE]),
      trueRate30: num(row[T.TRUE_RATE_30]),
      lifecycle: String(row[T.LIFECYCLE] || '').trim(),
      tacAvailableUnits: num(row[T.TAC_AVAILABLE]),
      availableCases: num(row[T.AVAILABLE_CASES]),
      tacDoi: num(row[T.TAC_DOI]),
      amzFulfillable: num(row[T.AMZ_FULFILLABLE]),
      amzReserved: num(row[T.AMZ_RESERVED]),
      amzInbound: num(row[T.AMZ_INBOUND]),
      amzTotal: num(row[T.AMZ_TOTAL]),
      amzDoi: num(row[T.AMZ_DOI]),
      caseQty: caseQtyFor(sku, row[T.CASE_QTY]),
      minUnits: floorFor(sku, row[T.MIN_UNITS]),
      awdAvailableUnits: num(row[T.AWD_AVAILABLE]),
    };
  });

  return {
    tacToAwd: tacToAwd,
    awdToFba: awdToFba,
    tacToFba: tacToFba,
    ltfIndex: ltfIndex,
    criticalIndex: critical,
    products: products,
    sheets: {
      tacToAwd: sheetByName(planner, cfg.TABS.TAC_TO_AWD),
      awdToFba: sheetByName(planner, cfg.TABS.AWD_TO_FBA),
      tacToFba: sheetByName(planner, cfg.TABS.TAC_TO_FBA),
    },
    meta: {
      minUnitsSource: minUnits.source,
      laneSource: cfg.SOURCES.LANES_FROM === 'ims' ? 'IMS' : 'planner',
      criticalCount: Object.keys(critical).length,
      ltfCount: Object.keys(ltfIndex).length,
      productCount: Object.keys(products).length,
    },
  };
}
