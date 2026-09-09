/**
 * Step one of the manual process: pull the current numbers out of the IMS and
 * paste them into the planner as values.
 *
 * Without this the planner is a copy of the last run and the lanes still hold
 * the last run's data. Everything downstream is then correct arithmetic on
 * stale inputs, which is the most expensive kind of wrong — it looks fine.
 *
 * Three things are deliberate:
 *
 *  - Values, not formulas. The planner is a record of what was decided and the
 *    numbers behind it; a live IMPORTRANGE would rewrite that record every time
 *    the IMS moves, and a back-test against it would measure nothing.
 *
 *  - Only inputs. Days of cover, cases to transfer and cover after the transfer
 *    are formulas in the planner (see Formulas.gs). Pasting the IMS's own
 *    versions over them would replace the live calculation with a dead number
 *    and undo the entire point of the exercise. The list of columns to skip is
 *    taken from the formula builders themselves, so the two cannot disagree.
 *
 *  - Locally-added columns survive. The Tactical minimum in column B is not in
 *    the IMS — it is looked up from the B2B tab and Marco keeps it visible on
 *    purpose. A blind paste would erase it, which is exactly how a floor of 100
 *    becomes a floor of nothing.
 */

/**
 * The IMS tab that feeds a lane. Pinned, never guessed.
 *
 * There used to be a header-matching fallback here. It cannot work: all three
 * IMS lane tabs open with the same six headers — B2B, name, Mrkt,
 * true_rate_30, order_plan_rate, product_life_cycle — so every one of them
 * scores the same against every lane. On 08-24 it picked `US TO AWD > FBA` for
 * the Tactical > AWD lane and pasted 491 rows into a tab with 29, and every
 * number after that was correct arithmetic on the wrong table.
 *
 * A pinned name that is missing fails loudly, which is the only safe way for
 * this to go wrong.
 */
function findImsLaneTab(ims, laneKey, cfg) {
  var name = (cfg.SOURCES.IMS_LANE_TABS || {})[laneKey];
  if (!name) {
    return { sheet: null, how: 'no IMS tab configured — set SOURCES.IMS_LANE_TABS.'
      + laneKey + ' in Config.gs' };
  }
  var sh = sheetByName(ims, name);
  if (!sh) {
    return { sheet: null, how: 'the IMS has no tab named "' + name
      + '" — check SOURCES.IMS_LANE_TABS.' + laneKey };
  }
  return { sheet: sh, how: 'configured name "' + name + '"' };
}

function headerKey(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Column indexes the lane's formulas own, so the refresh leaves them alone. */
function formulaColumns(laneKey, cfg) {
  var build = LANE_FORMULA_BUILDERS[laneKey];
  if (!build) return [];
  var owned = Object.keys(build(cfg.LAYOUT.LANE_FIRST_DATA_ROW, cfg))
    .map(Number);
  var work = laneWorkColumns(cfg, laneKey);
  Object.keys(work).forEach(function (k) { owned.push(work[k]); });
  owned.push(cfg.COLS[laneKey].REASON);
  return owned;
}

/**
 * Copy one lane's input values across, column by column.
 *
 * Columns are matched by header, not by position: the IMS and the planner do
 * not have to agree on layout, and a column that has moved on one side lands
 * where it belongs on the other.
 */
function refreshLane(ims, planner, laneKey, cfg) {
  var tabName = cfg.TABS[laneKey];
  var plannerSheet = sheetByName(planner, tabName);
  if (!plannerSheet) return { lane: tabName, ok: false, note: 'no such tab in the planner' };

  if (!isGridSheet(plannerSheet)) {
    return { lane: tabName, ok: false,
      note: 'the planner tab is a Connected Sheet — the script cannot write to it' };
  }

  var found = findImsLaneTab(ims, laneKey, cfg);
  if (!found.sheet) return { lane: tabName, ok: false, note: found.how };
  if (!isGridSheet(found.sheet)) {
    return { lane: tabName, ok: false, note: '"' + found.sheet.getName()
      + '" is a Connected Sheet — copy it to an ordinary tab first' };
  }

  var headerRow = cfg.LAYOUT.LANE_HEADER_ROW;
  var firstRow = cfg.LAYOUT.LANE_FIRST_DATA_ROW;

  var src = found.sheet;
  var srcHeader = src.getRange(headerRow, 1, 1, src.getLastColumn())
    .getValues()[0].map(headerKey);
  var dstHeader = plannerSheet.getRange(headerRow, 1, 1, plannerSheet.getLastColumn())
    .getValues()[0].map(headerKey);

  // How many rows the IMS tab really holds — counted on its SKU column, not
  // taken from getLastRow().
  //
  // The IMS `US TO Tactical > AWD` tab reports its last row as 5741 against
  // 491 SKUs; everything below carries stray formulas. Copying by getLastRow()
  // pasted 5,734 rows into the planner, reported "5734 rows" on the run header,
  // and handed that number on as the number of rows to calculate.
  // Matched by header text: the IMS carries the SKU one column left of the
  // planner, which adds its own columns on the left, so the planner's index
  // is the wrong thing to reach for here.
  var srcNameCol = srcHeader.indexOf(dstHeader[cfg.COLS[laneKey].NAME]);
  if (srcNameCol === -1) srcNameCol = srcHeader.indexOf('name');
  if (srcNameCol === -1) {
    return { lane: tabName, ok: false,
      note: 'the IMS tab has no "name" column to count SKUs on' };
  }
  var srcRows = countDataRows(src, srcNameCol, firstRow);
  if (srcRows <= 0) return { lane: tabName, ok: false, note: 'IMS tab has no SKUs' };
  var srcLast = firstRow + srcRows - 1;
  var srcValues = src.getRange(firstRow, 1, srcRows, src.getLastColumn()).getValues();

  var skip = (cfg.REFRESH.PRESERVE_COLS[laneKey] || []).slice();
  var derived = cfg.FORMULAS.ENABLED ? formulaColumns(laneKey, cfg) : [];
  derived.forEach(function (c) { if (skip.indexOf(c) === -1) skip.push(c); });

  var copied = [];
  var skipped = [];

  for (var d = 0; d < dstHeader.length; d++) {
    if (!dstHeader[d]) continue;
    if (skip.indexOf(d) !== -1) { skipped.push(d); continue; }
    var s = srcHeader.indexOf(dstHeader[d]);
    if (s === -1) continue;               // planner-only column: leave it alone

    var col = [];
    for (var r = 0; r < srcRows; r++) col.push([srcValues[r][s]]);
    plannerSheet.getRange(firstRow, d + 1, srcRows, 1).setValues(col);
    copied.push(d);
  }

  // Anything below the incoming data is last run's tail — clear it, or the
  // lane keeps SKUs the IMS no longer lists. Measured against the bottom of
  // the grid rather than getLastRow(), which is the number a previous
  // over-long paste has already inflated.
  var below = plannerSheet.getMaxRows() - srcLast;
  if (below > 0) {
    plannerSheet.getRange(srcLast + 1, 1, below,
      plannerSheet.getMaxColumns()).clearContent();
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

  var pinned = conf.SOURCES.IMS_LANE_TABS || {};
  var clash = duplicateLaneTabs(pinned);
  if (clash) {
    throw new Error('Two lanes are pinned to the same IMS tab ("' + clash
      + '"). All three IMS lane tabs share the same headers, so this is exactly'
      + ' the mistake that puts one lane\'s rows into another. Fix'
      + ' SOURCES.IMS_LANE_TABS in Config.gs.');
  }

  return ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].map(function (k) {
    return refreshLane(ims, planner, k, conf);
  });
}

/** The tab name two lanes share, or null. */
function duplicateLaneTabs(pinned) {
  var seen = {};
  var keys = ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'];
  for (var i = 0; i < keys.length; i++) {
    var name = pinned[keys[i]];
    if (!name) continue;
    if (seen[name]) return name;
    seen[name] = true;
  }
  return null;
}

function refreshLanesMenu() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var answer = ui.alert('Refresh from the IMS?',
    'The three lane tabs in "' + ss.getName() + '" will be overwritten with '
    + 'current values from the Inventory Monitoring Sheet.\n\nOnly input '
    + 'columns are touched. The calculated columns stay as formulas, and the '
    + 'Tactical minimum in column B is left alone.',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return null;

  var out = refreshLanesFromIms(ss, configFor(ss));
  var lines = out.map(function (r) {
    return (r.ok ? '✓ ' + r.lane + ' — ' + r.rows + ' rows from "' + r.from
      + '", ' + r.copied + ' input columns, ' + r.preserved + ' left as formulas'
      : '✗ ' + r.lane + ' — ' + r.note);
  });
  ui.alert('Refreshed from the IMS', lines.join('\n\n'), ui.ButtonSet.OK);
  return out;
}
