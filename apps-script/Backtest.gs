/**
 * §10.3 — replay a past planner through the live rules and diff the result
 * against what actually shipped.
 *
 * Note "shipped", not "typed". The lane decision columns travel with the file
 * when it is copied, so they hold a blend of several weeks' typing; the CSV
 * upload tabs and the AWD TO FBA pick list are what really went out. See
 * readShipped().
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
  var shipped = readShipped(ss, input, cfg);
  var actual = {
    tacToAwd: alignToRows(input.tacToAwd, shipped.tacToAwd),
    awdToFba: alignToRows(input.awdToFba, shipped.awdToFba),
    tacToFba: alignToRows(input.tacToFba, shipped.tacToFba),
  };

  var plan = planUsTransferOrders(input, cfg);
  var report = diffPlan(input, plan, actual, cfg);
  report.shippedNote = shipped.note;
  writeBacktestReport(ss, report, cfg, ss.getName());
  return report;
}

/**
 * What actually shipped, which is *not* the lane decision columns.
 *
 * Those carry forward when the file is copied, so they hold a mix of last
 * week's typing and this week's. The shipment is recorded elsewhere:
 *
 *   Tactical > AWD   CSV upload TACTICAL AWD
 *   Tactical > FBA   CSV upload TACTICAL FBA
 *   AWD > FBA        the AWD TO FBA tab
 *
 * and the CSV tabs carry a trandate. A tab that is empty, or dated to another
 * day, means nothing went out on that lane that run — so it counts as zeros,
 * not as missing data. Getting this wrong flatters the rules on the Tactical
 * lanes and slanders them on AWD.
 */
function readShipped(ss, input, cfg) {
  var date = plannerDate(ss.getName());
  var notes = [];

  var caseQty = {};
  [input.tacToAwd, input.tacToFba, input.awdToFba].forEach(function (rows) {
    rows.forEach(function (r) {
      if (r.caseQty > 0 && !caseQty[normSku(r.sku)]) caseQty[normSku(r.sku)] = r.caseQty;
    });
  });

  function fromCsv(tabName, label) {
    var sh = sheetByName(ss, tabName);
    var out = {};
    if (!sh) { notes.push(label + ': no tab'); return out; }
    var rows = readBlock(sh, cfg.LAYOUT.CSV_HEADER_ROW + 1);
    var used = 0;
    var stale = 0;
    rows.forEach(function (row) {
      var sku = normSku(row[3]);
      if (!sku) return;
      if (!isSameDay(row[1], date)) { stale++; return; }
      var q = caseQty[sku];
      if (!(q > 0)) return;
      out[sku] = (out[sku] || 0) + Math.round(num(row[4]) / q);
      used++;
    });
    notes.push(label + ': ' + (used ? used + ' rows for this run' : 'nothing shipped')
      + (stale ? ' (' + stale + ' from another run, ignored)' : ''));
    return out;
  }

  var awd = {};
  var awdSheet = sheetByName(ss, cfg.TABS.SUMMARY_AWD_FBA);
  if (awdSheet) {
    readBlock(awdSheet, cfg.LAYOUT.SUMMARY_HEADER_ROW + 1).forEach(function (row) {
      var sku = normSku(row[0]);
      if (sku) awd[sku] = (awd[sku] || 0) + num(row[3]);
    });
  }
  notes.push('AWD > FBA: ' + Object.keys(awd).length + ' SKUs on the pick list');

  return {
    tacToAwd: fromCsv(cfg.TABS.CSV_TAC_AWD, 'Tactical > AWD'),
    tacToFba: fromCsv(cfg.TABS.CSV_TAC_FBA, 'Tactical > FBA'),
    awdToFba: awd,
    note: (date ? 'shipment date ' + Utilities.formatDate(date, cfg.TIMEZONE, 'yyyy-MM-dd')
      : 'file name is not a date — CSV rows cannot be dated') + '. ' + notes.join('; '),
  };
}

/** SKU-keyed shipped cases, laid back out in lane row order. */
function alignToRows(rows, bySku) {
  return rows.map(function (r) { return bySku[normSku(r.sku)] || 0; });
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
    ['Back-test — ' + title + ' (vs what shipped, not what was typed)',
      '', '', '', '', ''],
    ['Run', Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd HH:mm z')],
    ['DSS used', 'Tac>AWD ' + dssFor(cfg, 'TAC_TO_AWD')
      + ', AWD>FBA ' + dssFor(cfg, 'AWD_TO_FBA')
      + ', Tac>FBA ' + dssFor(cfg, 'TAC_TO_FBA')],
    ['Pass 2 trigger', cfg.RULES.PASS2_TRIGGER_DOI === null
      ? 'always (spec)' : 'below ' + cfg.RULES.PASS2_TRIGGER_DOI + ' DOI'],
    ['Compared against', report.shippedNote || 'what shipped'],
    ['', ''],
    ['Lane', 'rows', 'same', 'differ', 'cases shipped', 'cases (script)'],
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
  sh.getRange(labelRow(head, 'Lane'), 1, 1, 6).setFontWeight('bold');
  sh.getRange(head.length, 1, 1, width).setFontWeight('bold')
    .setBackground(cfg.COLOURS.HEADER);
  sh.setFrozenRows(head.length);
  return sh;
}
