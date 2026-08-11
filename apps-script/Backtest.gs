/**
 * §10.3 — replay a past planner through the live rules and diff the result
 * against what Marco actually typed.
 *
 * Every difference is either a bug in here or a rule nobody has written down
 * yet, and there is no way to tell which from the outside. So the report gives
 * the inputs alongside both numbers: enough to adjudicate a row without
 * opening the source file.
 *
 * Reads only. It never writes into the lane columns of the file under test.
 */

function backtestThisFile() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return backtest(ss.getId());
}

/** Prompt for a file ID, so a past planner can be tested from the template. */
function backtestPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Back-test a past planner',
    'Paste the file ID or URL of the planner to replay:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  var text = res.getResponseText().trim();
  var m = text.match(/[-\w]{25,}/);
  return backtest(m ? m[0] : text);
}

/**
 * Replay `fileId` and write a `Back-test` tab into it.
 * Returns { lanes: {...}, rows: [...] } for use from the editor or tests.
 */
function backtest(fileId) {
  var cfg = config();
  var ss = SpreadsheetApp.openById(fileId);

  var input = readPlanningInput(ss, cfg);
  var actual = {
    tacToAwd: readDecisionColumn(input.sheets.tacToAwd, input.tacToAwd,
      cfg.COLS.TAC_TO_AWD),
    awdToFba: readDecisionColumn(input.sheets.awdToFba, input.awdToFba,
      cfg.COLS.AWD_TO_FBA),
    tacToFba: readDecisionColumn(input.sheets.tacToFba, input.tacToFba,
      cfg.COLS.TAC_TO_FBA),
  };

  var plan = planUsTransferOrders(input, cfg);
  var report = diffPlan(input, plan, actual, cfg);
  writeBacktestReport(ss, report, cfg, ss.getName());
  return report;
}

/** The cases a human typed, per lane row. */
function readDecisionColumn(sheet, rows, C) {
  var out = [];
  if (!sheet || !rows.length) return out;
  var first = rows[0].rowIndex;
  var span = rows[rows.length - 1].rowIndex - first + 1;
  var vals = sheet.getRange(first, C.CASES_OUT + 1, span, 1).getValues();
  rows.forEach(function (r) {
    out.push(num(vals[r.rowIndex - first][0]));
  });
  return out;
}

function diffPlan(input, plan, actual, cfg) {
  var lanes = [
    { key: 'tacToAwd', label: 'Tactical > AWD', rows: input.tacToAwd,
      dec: plan.tacToAwd, was: actual.tacToAwd },
    { key: 'awdToFba', label: 'AWD > FBA', rows: input.awdToFba,
      dec: plan.awdToFba, was: actual.awdToFba },
    { key: 'tacToFba', label: 'Tactical > FBA', rows: input.tacToFba,
      dec: plan.tacToFba, was: actual.tacToFba },
  ];

  var summary = {};
  var diffs = [];

  lanes.forEach(function (lane) {
    var match = 0;
    var differ = 0;
    lane.rows.forEach(function (r, i) {
      var mine = lane.dec[i] && lane.dec[i].cases > 0 ? lane.dec[i].cases : 0;
      var theirs = lane.was[i] > 0 ? lane.was[i] : 0;
      if (mine === theirs) { match++; return; }
      differ++;
      diffs.push([
        lane.label, r.rowIndex, r.sku, theirs, mine, mine - theirs,
        reasonText(lane.dec[i], r.caseQty),
        fmt(r.rate, 2),
        r.caseQty,
        r.availableCases,
        fmt(r.amzDoi === undefined ? r.awdDoi : r.amzDoi, 1),
        r.b2b ? 'Y' : '', r.critical ? 'Y' : '',
        r.lifecycle,
      ]);
    });
    summary[lane.key] = {
      label: lane.label, rows: lane.rows.length, match: match, differ: differ,
      casesMine: lane.dec.reduce(function (s, d) {
        return s + (d && d.cases > 0 ? d.cases : 0); }, 0),
      casesTheirs: lane.was.reduce(function (s, n) {
        return s + (n > 0 ? n : 0); }, 0),
    };
  });

  diffs.sort(function (a, b) { return Math.abs(b[5]) - Math.abs(a[5]); });
  return { lanes: summary, rows: diffs, pallet: plan.pallet };
}

function writeBacktestReport(ss, report, cfg, title) {
  var name = 'Back-test';
  var sh = sheetByName(ss, name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();

  var head = [
    ['Back-test — ' + title, '', '', '', '', ''],
    ['Run', Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd HH:mm z')],
    ['DSS used', 'Tac>AWD ' + dssFor(cfg, 'TAC_TO_AWD')
      + ', AWD>FBA ' + dssFor(cfg, 'AWD_TO_FBA')
      + ', Tac>FBA ' + dssFor(cfg, 'TAC_TO_FBA')],
    ['', ''],
    ['Lane', 'rows', 'same', 'differ', 'cases (typed)', 'cases (script)'],
  ];
  Object.keys(report.lanes).forEach(function (k) {
    var l = report.lanes[k];
    head.push([l.label, l.rows, l.match, l.differ, l.casesTheirs, l.casesMine]);
  });
  head.push(['', '']);
  head.push(['Differences, largest first', '']);
  head.push(['lane', 'row', 'SKU', 'typed', 'script', 'delta', 'script reason',
    'rate', 'case qty', 'cases avail', 'dest DOI', 'B2B', 'Critical', 'lifecycle']);

  var width = 14;
  var rows = head.map(function (r) {
    var padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded;
  }).concat(report.rows);

  sh.getRange(1, 1, rows.length, width).setValues(rows);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground(cfg.COLOURS.HEADER);
  sh.getRange(5, 1, 1, 6).setFontWeight('bold');
  sh.getRange(head.length, 1, 1, width).setFontWeight('bold')
    .setBackground(cfg.COLOURS.HEADER);
  sh.setFrozenRows(head.length);
  return sh;
}
