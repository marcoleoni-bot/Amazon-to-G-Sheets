/**
 * Entry points.
 *
 * The template is the thing you keep. Every run makes a dated copy of it in
 * `Transfer orders / MM. Month / US /` and plans into that — rather than
 * duplicating last week's file, which carries last week's hand-typed decisions
 * forward to be cleared or, worse, not cleared.
 */

/**
 * Four items and a drawer.
 *
 * There were ten, in three groups, and picking the wrong one was easy and
 * expensive. On an ordinary Thursday only the first is needed: it makes the
 * dated copy, pulls the IMS, rebuilds the formulas and decides all three
 * lanes. The second is for after a dial has been changed on the Settings tab.
 * Everything else is a tool, and tools go in a drawer.
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Transfer Orders')
    .addItem('▶  Build this week\'s plan', 'buildPlan')
    .addItem('↻  Re-plan this file', 'buildPlanHere')
    .addSeparator()
    .addItem('Open the Settings tab', 'openSettings')
    .addItem('Record what shipped', 'recordShippedMenu')
    .addSubMenu(ui.createMenu('Tools')
      .addItem('Dry run — decide, write nothing', 'dryRun')
      .addItem('Refresh the lanes from the IMS', 'refreshLanesMenu')
      .addItem('Rebuild the formulas', 'rebuildFormulasMenu')
      .addItem('Authorise data sources', 'authoriseDataSourcesMenu')
      .addSeparator()
      .addItem('Scorecard — proposal vs shipment', 'historyScorecardMenu')
      .addItem('Back-fill history from past planners…', 'backfillHistoryMenu')
      .addItem('Back-test this file', 'backtestThisFile')
      .addItem('Back-test another planner…', 'backtestPrompt')
      .addSeparator()
      .addItem('Settings in force (script view)', 'showSettings'))
    .addToUi();
}

/** Jump to the dials rather than hunting for the tab. */
function openSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = config();
  var sh = sheetByName(ss, cfg.TABS.SETTINGS);
  if (!sh) sh = ensureSettings(ss, cfg).sheet;
  ss.setActiveSheet(sh);
  return sh;
}

/** Rewrite the derived columns without touching the pasted inputs. */
function rebuildFormulasMenu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = config();
  ensureSettings(ss, cfg);
  var out = writeAllFormulas(ss, laneRowCounts(ss, cfg),
    resolveTabNames(ss, configFor(ss, cfg)));
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert('Formulas rebuilt',
    out.map(function (r) {
      return r.ok ? '✓ ' + r.lane + ' — ' + r.rows + ' rows, ' + r.columns
        + ' calculated columns' : '✗ ' + r.lane + ' — ' + r.note;
    }).join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
  return out;
}

/** Copy the template into the dated folder, then plan into the copy. */
function buildPlan() {
  var cfg = config();
  var template = SpreadsheetApp.getActiveSpreadsheet();
  var copy = createDatedPlanner(template, new Date(), cfg);
  var result = runPlan(copy, cfg, { snapshot: 'live' });
  report_(result, copy);
  return result;
}

/** Plan into the file that is already open. */
function buildPlanHere() {
  var cfg = config();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Re-plan "' + ss.getName() + '"?',
    'The lanes are refreshed from the IMS, the calculated columns are rebuilt '
    + 'as formulas, and the reasons, summary and CSV tabs are regenerated.\n\n'
    + 'Any quantity typed over a formula by hand will be replaced.',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return null;

  var result = runPlan(ss, cfg, { snapshot: 'live, in place' });
  report_(result, ss);
  return result;
}

/** Compute everything, write nothing, show what would have happened. */
function dryRun() {
  var cfg = config();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // The refresh runs here too. A dry run against last week's numbers tells you
  // nothing about this week, and the refresh touches inputs, not decisions.
  authoriseDataSources(ss, cfg);
  ensureSettings(ss, cfg);
  cfg = configFor(ss, cfg);
  var refreshed = cfg.REFRESH.ENABLED ? refreshLanesFromIms(ss, cfg) : null;
  if (refreshed) SpreadsheetApp.flush();

  var input = readPlanningInput(ss, cfg);
  var plan = planUsTransferOrders(input, cfg);

  var lines = verdictLines(plan).concat([
    '',
    'Pallet: ' + palletStatus(plan.pallet),
    'Needs review: ' + plan.totals.needsReview,
    'LTF flagged:  ' + plan.totals.ltfHeld,
    'Floor breaches: ' + plan.totals.floorBreaches,
    '',
    'Tactical floor from: ' + input.meta.minUnitsSource,
    '',
    refreshed
      ? 'Lanes refreshed: ' + refreshed.map(function (r) {
        return r.ok ? r.rows + ' rows from "' + r.from + '"' : r.lane + ' FAILED';
      }).join(' · ')
      : 'Lanes NOT refreshed — planning against whatever is in the tabs.',
  ]);
  SpreadsheetApp.getUi().alert('Dry run — no decisions written', lines.join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
  return plan;
}

/**
 * Read, decide, write. The one path both menu items share.
 *
 * The order matters and is the manual process, in the manual order:
 *
 *   1. authorise, so nothing reads #REF! where a floor should be
 *   2. the Settings tab, because the formulas reference it by name
 *   3. the IMS, pasted in as values — the frozen record of this run's inputs
 *   4. the formulas, which turn those inputs into cover, cases and units
 *   5. read what the sheet worked out, and run the same rules over it
 *   6. reconcile: where the two differ, the sheet wins and the row is flagged
 *   7. reasons, colours, summaries, CSV, history
 */
function runPlan(planner, cfg, ctx) {
  // Clear the IMPORTRANGE grants before reading, so a fresh copy does not plan
  // against a sheet full of #REF!.
  authoriseDataSources(planner, cfg);

  // The dials, on a tab, as named ranges the lane formulas can reference —
  // and read back, so the rule engine works from the same numbers.
  ensureSettings(planner, cfg);
  cfg = configFor(planner, cfg);

  // Step one of the manual process: current values out of the IMS, pasted in.
  // Skipping it means planning against the previous run's numbers.
  var refreshed = null;
  if (cfg.REFRESH.ENABLED) {
    refreshed = refreshLanesFromIms(planner, cfg);
    var failed = refreshed.filter(function (r) { return !r.ok; });
    if (failed.length === refreshed.length) {
      throw new Error('Could not refresh any lane from the IMS:\n  '
        + failed.map(function (r) { return r.lane + ' — ' + r.note; }).join('\n  ')
        + '\n\nCheck SOURCES.IMS_LANE_TABS in Config.gs against the IMS tab names.');
    }
    SpreadsheetApp.flush();
  }

  // Everything derived, as formulas over those values. Tab names are resolved
  // from the file first: the script matches them loosely, a formula cannot.
  //
  // The refresh knows exactly how many rows it pasted, so it decides how far
  // the formulas run. Reading that back off the sheet instead is what wrote
  // 5,734 rows onto a 491-row lane.
  var formulas = null;
  if (cfg.FORMULAS.ENABLED) {
    formulas = writeAllFormulas(planner, refreshedRowCounts(refreshed, planner, cfg),
      resolveTabNames(planner, cfg));
    var noFormulas = formulaFailures(formulas);
    if (noFormulas.length) {
      throw new Error('These lanes got no calculated columns:\n  '
        + noFormulas.map(function (r) { return r.lane + ' — ' + r.note; }).join('\n  ')
        + '\n\nNothing has been decided. Fix that and run again rather than '
        + 'raising an order from a lane that was never calculated.');
    }
    SpreadsheetApp.flush();
  }

  var input = readPlanningInput(planner, cfg);
  input.meta.refreshed = refreshed;
  input.meta.formulas = formulas;
  var plan = planUsTransferOrders(input, cfg);

  // The sheet is what ships. Where it and the rules disagree, take the sheet's
  // number and say so on the row.
  if (cfg.FORMULAS.ENABLED) reconcileWithSheet(input, plan, cfg);

  writePlan(planner, input, plan, cfg, ctx);
  // Log every decision, shipped column blank until the orders are raised.
  try {
    appendHistory(planner, input, plan, cfg);
  } catch (e) {
    // A history failure must never cost a plan that is otherwise good.
    console.error('TO history not written: ' + e.message);
  }
  SpreadsheetApp.flush();
  return { planner: planner, input: input, plan: plan };
}

/** The three verdicts, as the first thing any dialog says. */
function verdictLines(plan) {
  var v = plan.verdicts;
  return [
    'RAISE THIS ORDER?',
    '',
    (v.tacToAwd.raise ? '\u2713 ' : '\u2013 ') + 'Tactical > AWD:  '
      + (v.tacToAwd.raise ? 'YES' : 'NO') + ' \u2014 ' + v.tacToAwd.why,
    (v.awdToFba.raise ? '\u2713 ' : '\u2013 ') + 'AWD > FBA:       '
      + (v.awdToFba.raise ? 'YES' : 'NO') + ' \u2014 ' + v.awdToFba.why,
    (v.tacToFba.raise ? '\u2713 ' : '\u2013 ') + 'Tactical > FBA:  '
      + (v.tacToFba.raise ? 'YES' : 'NO') + ' \u2014 ' + v.tacToFba.why,
  ];
}

function report_(result, ss) {
  var p = result.plan;
  var ui = SpreadsheetApp.getUi();
  var lines = [ss.getName(), ''].concat(verdictLines(p), ['',
    'Pallet: ' + palletStatus(p.pallet),
    'Needs review: ' + p.totals.needsReview,
    'LTF flagged: ' + p.totals.ltfHeld]);

  if (p.reconcile) {
    lines.push(p.reconcile.differed === 0
      ? 'Sheet and rules agree on all ' + p.reconcile.checked + ' rows.'
      : '⚠ ' + p.reconcile.differed + ' of ' + p.reconcile.checked
        + ' rows differ between the sheet and the rules — the sheet\'s number '
        + 'is the one on the row:\n    ' + p.reconcile.examples.join('\n    '));
  }

  lines.push('', 'Every calculated column is a live formula. Change a rate, or '
    + 'a dial on the Settings tab, and the projection moves with it.', '',
    ss.getUrl());
  ui.alert('Plan built', lines.join('\n'), ui.ButtonSet.OK);
}

function showSettings() {
  var cfg = config();
  var lines = CONFIG_OVERRIDABLE.map(function (path) {
    return path + ' = ' + JSON.stringify(getByPath_(cfg, path));
  });
  lines.push('', 'Override any of these in File > Project properties >',
    'Script properties, using the key exactly as shown.');
  SpreadsheetApp.getUi().alert('Settings in force', lines.join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function getByPath_(obj, path) {
  return path.split('.').reduce(function (n, k) {
    return (n === null || n === undefined) ? n : n[k];
  }, obj);
}

// ------------------------------------------------------------------- filing

/** `Transfer orders / MM. Month / US /`, creating the folders if absent. */
function targetFolder(date, cfg) {
  var root = DriveApp.getFolderById(cfg.SOURCES.TRANSFER_ORDERS_FOLDER_ID);
  var monthName = cfg.MONTH_FOLDERS[date.getMonth()];
  return childFolder(childFolder(root, monthName), cfg.MARKET);
}

function childFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Planner files are named MM-DD-YY, matching what is already in the folder. */
function plannerName(date, cfg) {
  return Utilities.formatDate(date, cfg.TIMEZONE, 'MM-dd-yy');
}

function createDatedPlanner(template, date, cfg) {
  var folder = targetFolder(date, cfg);
  var name = plannerName(date, cfg);

  var existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert('"' + name + '" already exists',
      'Open the existing file instead of making another copy?',
      ui.ButtonSet.YES_NO);
    if (answer === ui.Button.YES) {
      return SpreadsheetApp.openById(existing.next().getId());
    }
    name = name + ' (' + Utilities.formatDate(date, cfg.TIMEZONE, 'HHmm') + ')';
  }

  var file = DriveApp.getFileById(template.getId()).makeCopy(name, folder);
  return SpreadsheetApp.openById(file.getId());
}
