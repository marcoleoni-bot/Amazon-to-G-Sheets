/**
 * Entry points.
 *
 * The template is the thing you keep. Every run makes a dated copy of it in
 * `Transfer orders / MM. Month / US /` and plans into that — rather than
 * duplicating last week's file, which carries last week's hand-typed decisions
 * forward to be cleared or, worse, not cleared.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Transfer Orders')
    .addItem('Build US plan', 'buildPlan')
    .addItem('Build US plan in this file', 'buildPlanHere')
    .addSeparator()
    .addItem('Dry run (report only, writes nothing)', 'dryRun')
    .addItem('Back-test this file against its own numbers', 'backtestThisFile')
    .addItem('Back-test another planner…', 'backtestPrompt')
    .addSeparator()
    .addItem('Show settings', 'showSettings')
    .addToUi();
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
  var answer = ui.alert('Build the plan in "' + ss.getName() + '"?',
    'Decision columns, reasons, summary and CSV tabs in this file will be '
    + 'overwritten.', ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return null;

  var result = runPlan(ss, cfg, { snapshot: 'live, in place' });
  report_(result, ss);
  return result;
}

/** Compute everything, write nothing, show what would have happened. */
function dryRun() {
  var cfg = config();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var input = readPlanningInput(ss, cfg);
  var plan = planUsTransferOrders(input, cfg);

  var lines = [
    'Tactical > AWD:  ' + plan.totals.tacToAwdCases + ' cases',
    'AWD > FBA:       ' + plan.totals.awdToFbaCases + ' cases',
    'Tactical > FBA:  ' + plan.totals.tacToFbaCases + ' cases',
    '',
    'Pallet: ' + palletStatus(plan.pallet),
    'Needs review: ' + plan.totals.needsReview,
    'LTF flagged:  ' + plan.totals.ltfHeld,
    'Floor breaches: ' + plan.totals.floorBreaches,
    '',
    'Tactical floor from: ' + input.meta.minUnitsSource,
  ];
  SpreadsheetApp.getUi().alert('Dry run — nothing written', lines.join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
  return plan;
}

/** Read, decide, write. The one path both menu items share. */
function runPlan(planner, cfg, ctx) {
  var input = readPlanningInput(planner, cfg);
  var plan = planUsTransferOrders(input, cfg);
  writePlan(planner, input, plan, cfg, ctx);
  SpreadsheetApp.flush();
  return { planner: planner, input: input, plan: plan };
}

function report_(result, ss) {
  var p = result.plan;
  var ui = SpreadsheetApp.getUi();
  ui.alert('Plan built',
    ss.getName() + '\n\n'
    + 'Tactical > AWD:  ' + p.totals.tacToAwdCases + ' cases\n'
    + 'AWD > FBA:       ' + p.totals.awdToFbaCases + ' cases\n'
    + 'Tactical > FBA:  ' + p.totals.tacToFbaCases + ' cases\n\n'
    + 'Pallet: ' + palletStatus(p.pallet) + '\n'
    + 'Needs review: ' + p.totals.needsReview + '\n'
    + 'LTF flagged: ' + p.totals.ltfHeld + '\n\n'
    + ss.getUrl(),
    ui.ButtonSet.OK);
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
