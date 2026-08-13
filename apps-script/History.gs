/**
 * `TO history` — one append-only row per SKU per lane per run.
 *
 * The point is not record-keeping. Every run already produces a labelled
 * example: the inputs the rules saw, the quantity they proposed, and — once
 * the order is raised — the quantity that actually shipped. Kept in one place
 * and replayed, that is the only honest measure of whether the rules are
 * converging on the judgement they are meant to reproduce.
 *
 * Rows are written at plan time with `shipped` blank. `recordShipped()` fills
 * that in afterwards from the CSV tabs and the pick list, which is why the run
 * date has to match — a CSV dated to another day belongs to another run.
 *
 * Living in its own workbook (HISTORY_ID) means the record survives a planner
 * being deleted, renamed or re-run. Left unset, it falls back to a tab in the
 * planner itself, which is better than nothing but forgets as fast as the file.
 */

var HISTORY_HEADER = ['run_date', 'lane', 'sku', 'proposed_cases', 'shipped_cases',
  'delta', 'rule', 'flags', 'rate', 'true_rate_30', 'case_qty', 'source_doi',
  'dest_doi', 'available_cases', 'min_units', 'b2b', 'critical', 'lifecycle',
  'recorded_at'];

function historySheet(planner, cfg, createIfMissing) {
  var ss = planner;
  if (cfg.SOURCES.HISTORY_ID) {
    try {
      ss = SpreadsheetApp.openById(cfg.SOURCES.HISTORY_ID);
    } catch (e) {
      ss = planner; // fall back rather than lose the run
    }
  }
  var sh = sheetByName(ss, cfg.TABS.HISTORY);
  if (!sh && createIfMissing) {
    sh = ss.insertSheet(cfg.TABS.HISTORY);
    sh.getRange(1, 1, 1, HISTORY_HEADER.length).setValues([HISTORY_HEADER])
      .setFontWeight('bold').setBackground(cfg.COLOURS.HEADER);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** One row per decision, proposed only. Returns how many were appended. */
function appendHistory(planner, input, plan, cfg) {
  var sh = historySheet(planner, cfg, true);
  if (!sh) return 0;

  var runDate = plannerDate(planner.getName()) || new Date();
  var stamp = new Date();
  var rows = [];

  function add(laneName, laneRows, decisions, sourceDoiOf) {
    laneRows.forEach(function (r, i) {
      var d = decisions[i];
      if (!d) return;
      // Every SKU, not just the ones that moved. A zero with a reason is the
      // more common decision and just as much a labelled example.
      rows.push([
        runDate, laneName, r.sku, d.cases > 0 ? d.cases : 0, '', '',
        d.rule, (d.flags || []).join('|'),
        r.rate, r.trueRate30 === undefined ? '' : r.trueRate30, r.caseQty,
        sourceDoiOf(r), r.amzDoi === undefined ? r.awdDoi : r.amzDoi,
        r.availableCases, r.minUnits === null ? 'UNREADABLE' : r.minUnits,
        r.b2b ? 'Y' : '', r.critical ? 'Y' : '', r.lifecycle, stamp,
      ]);
    });
  }

  add('Tactical > AWD', input.tacToAwd, plan.tacToAwd, function (r) { return r.wrDoi; });
  add('AWD > FBA', input.awdToFba, plan.awdToFba, function (r) { return r.awdDoi; });
  add('Tactical > FBA', input.tacToFba, plan.tacToFba, function (r) { return r.tacDoi; });

  if (!rows.length) return 0;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HISTORY_HEADER.length)
    .setValues(rows);
  return rows.length;
}

/**
 * Fill in what actually shipped, for a run already recorded.
 *
 * Run it after the orders are raised — the CSV tabs carry no TO number until
 * then, and the pick list is only truth once it has been typed into Seller
 * Central. Re-running is safe: rows are matched on (run_date, lane, sku) and
 * overwritten, so a corrected shipment corrects the record.
 */
function recordShipped(planner, cfg) {
  var conf = cfg || config();
  var ss = planner || SpreadsheetApp.getActiveSpreadsheet();
  var sh = historySheet(ss, conf, false);
  if (!sh) throw new Error('No "' + conf.TABS.HISTORY + '" tab yet — build a plan first.');

  var input = readPlanningInput(ss, conf);
  var shipped = readShipped(ss, input, conf);
  var runDate = plannerDate(ss.getName());
  if (!runDate) throw new Error('"' + ss.getName() + '" is not named MM-DD-YY, '
    + 'so its rows cannot be matched to a run.');

  var byLane = {
    'Tactical > AWD': shipped.tacToAwd,
    'AWD > FBA': shipped.awdToFba,
    'Tactical > FBA': shipped.tacToFba,
  };

  var last = sh.getLastRow();
  if (last < 2) return { updated: 0, note: 'no history rows yet' };
  var vals = sh.getRange(2, 1, last - 1, HISTORY_HEADER.length).getValues();
  var updated = 0;

  for (var i = 0; i < vals.length; i++) {
    if (!isSameDay(vals[i][0], runDate)) continue;
    var lane = byLane[vals[i][1]];
    if (!lane) continue;
    var got = lane[normSku(vals[i][2])] || 0;
    var proposed = num(vals[i][3]);
    vals[i][4] = got;
    vals[i][5] = got - proposed;
    updated++;
  }

  sh.getRange(2, 1, vals.length, HISTORY_HEADER.length).setValues(vals);
  return { updated: updated, note: shipped.note };
}

/**
 * How well the rules have been agreeing with the decisions, per lane and per
 * run, from the history alone. This is the number that should go up.
 */
function historyScorecard(planner, cfg) {
  var conf = cfg || config();
  var ss = planner || SpreadsheetApp.getActiveSpreadsheet();
  var sh = historySheet(ss, conf, false);
  if (!sh || sh.getLastRow() < 2) return { runs: [], note: 'no history yet' };

  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, HISTORY_HEADER.length).getValues();
  var byRun = {};

  vals.forEach(function (v) {
    if (v[4] === '' || v[4] === null) return;   // not yet reconciled
    var key = Utilities.formatDate(new Date(v[0]), conf.TIMEZONE, 'yyyy-MM-dd')
      + ' · ' + v[1];
    if (!byRun[key]) byRun[key] = { rows: 0, same: 0, proposed: 0, shipped: 0 };
    var b = byRun[key];
    b.rows++;
    b.proposed += num(v[3]);
    b.shipped += num(v[4]);
    if (num(v[3]) === num(v[4])) b.same++;
  });

  var runs = Object.keys(byRun).sort().map(function (k) {
    var b = byRun[k];
    return {
      run: k, rows: b.rows, same: b.same,
      agreement: b.rows ? Math.round(1000 * b.same / b.rows) / 10 : 0,
      proposed: b.proposed, shipped: b.shipped,
    };
  });
  return { runs: runs };
}

// ------------------------------------------------------------------ menu

function recordShippedMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = recordShipped(SpreadsheetApp.getActiveSpreadsheet(), config());
    ui.alert('Shipment recorded',
      res.updated + ' history rows updated with what actually shipped.\n\n'
      + res.note + '\n\nRe-run this any time the shipment changes — rows are '
      + 'matched on run date, lane and SKU, so it corrects rather than duplicates.',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Could not record the shipment', e.message, ui.ButtonSet.OK);
  }
}

function historyScorecardMenu() {
  var ui = SpreadsheetApp.getUi();
  var card = historyScorecard(SpreadsheetApp.getActiveSpreadsheet(), config());
  if (!card.runs.length) {
    ui.alert('Scorecard', card.note || 'Nothing reconciled yet — raise an order, '
      + 'then run "Record what shipped".', ui.ButtonSet.OK);
    return;
  }
  var lines = card.runs.map(function (r) {
    return r.run + '  ' + r.same + '/' + r.rows + ' rows (' + r.agreement + '%)'
      + '  proposed ' + r.proposed + ' vs shipped ' + r.shipped;
  });
  lines.unshift('Agreement between proposal and shipment:', '');
  ui.alert('Scorecard', lines.join('\n'), ui.ButtonSet.OK);
}
