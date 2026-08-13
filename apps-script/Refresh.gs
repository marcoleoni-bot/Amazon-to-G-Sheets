/**
 * Step one of the manual process, which the script had been skipping: pull the
 * current numbers out of the IMS and paste them into the planner as values.
 *
 * Without this the planner is a copy of the last run and the lanes still hold
 * the last run's data. Everything downstream is then correct arithmetic on
 * stale inputs, which is the most expensive kind of wrong — it looks fine.
 *
 * Two things are deliberate:
 *
 *  - Values, not formulas. The planner is a record of what was decided and the
 *    numbers behind it; a live formula would rewrite that record every time
 *    the IMS moves, and a back-test against it would measure nothing.
 *
 *  - Locally-added columns survive. The Tactical minimum in column B is not in
 *    the IMS — it is looked up from the B2B tab and Marco keeps it visible on
 *    purpose. A blind paste would erase it, which is exactly how a floor of 100
 *    becomes a floor of nothing.
 */

/**
 * Find the IMS tab that feeds a lane.
 *
 * Prefers the configured name, then matches on the header row itself. Matching
 * on headers rather than names means a renamed tab still resolves, and a tab
 * that has been restructured fails loudly instead of pasting the wrong columns
 * into the right ones.
 */
function findImsLaneTab(ims, plannerSheet, configuredName, cfg) {
  if (configuredName) {
    var named = sheetByName(ims, configuredName);
    if (named) return { sheet: named, how: 'configured name' };
  }

  var headerRow = cfg.LAYOUT.LANE_HEADER_ROW;
  var want = plannerSheet.getRange(headerRow, 1, 1, plannerSheet.getLastColumn())
    .getValues()[0].map(headerKey).filter(String);
  if (!want.length) return { sheet: null, how: 'planner has no header row' };

  var best = null;
  ims.getSheets().forEach(function (sh) {
    if (sh.getLastRow() < headerRow || sh.getLastColumn() < 1) return;
    var got = sh.getRange(headerRow, 1, 1, sh.getLastColumn())
      .getValues()[0].map(headerKey);
    var hits = 0;
    want.forEach(function (h) { if (got.indexOf(h) !== -1) hits++; });
    var score = hits / want.length;
    if (!best || score > best.score) best = { sheet: sh, score: score };
  });

  if (best && best.score >= cfg.REFRESH.HEADER_MATCH_MIN) {
    return { sheet: best.sheet, how: 'header match ' + Math.round(100 * best.score) + '%' };
  }
  return {
    sheet: null,
    how: 'no IMS tab matched the header (best '
      + (best ? Math.round(100 * best.score) + '%' : 'none') + ')',
  };
}

function headerKey(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Copy one lane's values across, column by column, honouring the preserve list.
 *
 * Columns are matched by header, not by position: the IMS and the planner do
 * not have to agree on layout, and a column that has moved on one side lands
 * where it belongs on the other.
 */
function refreshLane(ims, planner, laneKey, cfg) {
  var tabName = cfg.TABS[laneKey];
  var plannerSheet = sheetByName(planner, tabName);
  if (!plannerSheet) return { lane: tabName, ok: false, note: 'no such tab in the planner' };

  var found = findImsLaneTab(ims, plannerSheet,
    cfg.SOURCES.IMS_LANE_TABS[laneKey], cfg);
  if (!found.sheet) return { lane: tabName, ok: false, note: found.how };

  var headerRow = cfg.LAYOUT.LANE_HEADER_ROW;
  var firstRow = cfg.LAYOUT.LANE_FIRST_DATA_ROW;

  var src = found.sheet;
  var srcHeader = src.getRange(headerRow, 1, 1, src.getLastColumn())
    .getValues()[0].map(headerKey);
  var dstHeader = plannerSheet.getRange(headerRow, 1, 1, plannerSheet.getLastColumn())
    .getValues()[0].map(headerKey);

  var srcLast = src.getLastRow();
  if (srcLast < firstRow) return { lane: tabName, ok: false, note: 'IMS tab has no data' };
  var srcRows = srcLast - firstRow + 1;
  var srcValues = src.getRange(firstRow, 1, srcRows, src.getLastColumn()).getValues();

  var preserve = (cfg.REFRESH.PRESERVE_COLS[laneKey] || []).slice();
  var copied = [];
  var skipped = [];

  for (var d = 0; d < dstHeader.length; d++) {
    if (!dstHeader[d]) continue;
    if (preserve.indexOf(d) !== -1) { skipped.push(d); continue; }
    var s = srcHeader.indexOf(dstHeader[d]);
    if (s === -1) continue;               // planner-only column: leave it alone

    var col = [];
    for (var r = 0; r < srcRows; r++) col.push([srcValues[r][s]]);
    plannerSheet.getRange(firstRow, d + 1, srcRows, 1).setValues(col);
    copied.push(d);
  }

  // Anything below the incoming data is last run's tail — clear it, or the
  // lane keeps SKUs the IMS no longer lists.
  var dstLast = plannerSheet.getLastRow();
  if (dstLast > srcLast) {
    plannerSheet.getRange(srcLast + 1, 1, dstLast - srcLast,
      plannerSheet.getLastColumn()).clearContent();
  }

  return {
    lane: tabName, ok: true, rows: srcRows, from: src.getName(), how: found.how,
    copied: copied.length, preserved: skipped.length,
  };
}

/** Refresh all three lanes. Returns one result per lane. */
function refreshLanesFromIms(planner, cfg) {
  var conf = cfg || config();
  var ims = SpreadsheetApp.openById(conf.SOURCES.IMS_ID);
  return ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].map(function (k) {
    return refreshLane(ims, planner, k, conf);
  });
}

function refreshLanesMenu() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var answer = ui.alert('Refresh from the IMS?',
    'The three lane tabs in "' + ss.getName() + '" will be overwritten with '
    + 'current values from the Inventory Monitoring Sheet.\n\nColumns the '
    + 'planner adds itself — the Tactical minimum in column B — are left alone.',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return null;

  var out = refreshLanesFromIms(ss, config());
  var lines = out.map(function (r) {
    return (r.ok ? '✓ ' + r.lane + ' — ' + r.rows + ' rows from "' + r.from
      + '" (' + r.how + '), ' + r.copied + ' columns, ' + r.preserved + ' preserved'
      : '✗ ' + r.lane + ' — ' + r.note);
  });
  ui.alert('Refreshed from the IMS', lines.join('\n\n'), ui.ButtonSet.OK);
  return out;
}
