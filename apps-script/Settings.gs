/**
 * The dials, on a tab, as named ranges.
 *
 * Until now every threshold lived in Config.gs and reached the sheet only as a
 * number already applied — 75 days of AWD cover became "3 cases" and the 75
 * disappeared. Changing it meant editing code and running again.
 *
 * Here the numbers live in one visible place and the lane formulas reference
 * them by name. Change `TacAwd_TargetDoi` from 75 to 90 and the whole Tactical
 * > AWD column reprices in front of you. Nothing is recomputed in the
 * background, and nothing has to be re-run to see the effect.
 *
 * Config.gs stays the default: the tab is built from it the first time, and
 * read back into the running config after that, so the script and the sheet
 * always work from the same set of numbers.
 */

/**
 * The names the lane formulas use.
 *
 * One map, referenced by both sides, so a rename cannot leave a formula
 * pointing at a name that no longer exists — which shows up as #NAME? in 491
 * cells and nowhere else.
 */
var SETTINGS_NAMES = {
  DSS: 'Dss_BaselineDoi',
  PRIORITY_DOI: 'Priority_Doi',

  TAC_AWD_GATE_AWD: 'TacAwd_GateAwdDoi',
  TAC_AWD_GATE_FBA: 'TacAwd_GateFbaDoi',
  TAC_AWD_TARGET: 'TacAwd_TargetDoi',
  PALLET_MIN: 'Pallet_MinCases',

  AWD_FBA_RESERVED_RATIO: 'AwdFba_ReservedRatio',
  AWD_FBA_PASS1_TRIGGER: 'AwdFba_Pass1TriggerDoi',
  AWD_FBA_PASS1_TARGET: 'AwdFba_Pass1TargetDoi',
  AWD_FBA_PASS2_TRIGGER: 'AwdFba_Pass2TriggerDoi',
  AWD_FBA_MAX_AFTER: 'AwdFba_MaxDoiAfter',
  AWD_FBA_REVIEW_ABOVE: 'AwdFba_ReviewAboveCases',

  TAC_FBA_SPIKE: 'TacFba_SpikeMultiplier',
  TAC_FBA_DISC_AIM: 'TacFba_DiscontinuedAimDoi',
  TAC_FBA_DISC_MAX: 'TacFba_DiscontinuedMaxDoi',
  TAC_FBA_BREACH_MAX: 'TacFba_FloorBreachMaxDoi',
  TAC_FBA_BREACH_RESTORE: 'TacFba_FloorBreachRestoreDoi',
  TAC_FBA_BREACH_TOLERANCE: 'TacFba_FloorBreachTolerance',

  PASS1_RATE: 'Pass1_Rate',
  CONTENTION_FBA_DOI: 'Contention_FbaDoi',

  FBA_MIN_UNITS: 'Fba_MinUnitsBySku',

  RUN_TAC_AWD_QUALIFYING: 'Run_TacAwdQualifyingCases',
  RUN_TAC_AWD_VERDICT: 'Run_TacAwdVerdict',
};

/**
 * Named range -> the Config path it mirrors.
 *
 * `kind` is what the cell holds:
 *   'number'  a plain number
 *   'text'    a string dial (PASS1_RATE)
 *   'table'   a two-column lookup, read into an object
 *   'formula' derived on the tab itself; never read back into config
 */
var SETTINGS_DIALS = [
  { section: 'Everywhere' },
  { name: 'Dss_BaselineDoi', path: 'RULES.DSS', kind: 'number',
    label: 'Baseline days of stock (DSS)',
    note: 'The target every ordinary SKU is topped up to.' },
  { name: 'Priority_Doi', path: 'RULES.PRIORITY_DOI', kind: 'number',
    label: 'B2B / Critical target (DOI)',
    note: 'Priority SKUs aim here instead of the baseline.' },

  { section: 'Tactical > AWD' },
  { name: 'TacAwd_GateAwdDoi', path: 'RULES.TAC_TO_AWD_GATE_AWD_DOI', kind: 'number',
    label: 'Only if AWD cover is under (DOI)',
    note: 'Above this, AWD has enough and the row is skipped.' },
  { name: 'TacAwd_GateFbaDoi', path: 'RULES.TAC_TO_AWD_GATE_FBA_DOI', kind: 'number',
    label: '...and FBA cover is under (DOI)',
    note: 'Both ends must be short. Thin at AWD with FBA comfortable is not a '
      + 'reason to move a pallet.' },
  { name: 'TacAwd_TargetDoi', path: 'RULES.TAC_TO_AWD_TARGET_DOI', kind: 'number',
    label: 'Top AWD up to (DOI)',
    note: 'The quantity is whatever it takes to reach this.' },
  { name: 'Pallet_MinCases', path: 'RULES.PALLET_MIN_CASES', kind: 'number',
    label: 'Pallet minimum (cases)',
    note: 'The lane ships palletised. Under this the whole run holds for a '
      + 'later one rather than padding with SKUs that do not need anything.' },

  { section: 'AWD > FBA' },
  { name: 'AwdFba_ReservedRatio', path: 'RULES.PASS1_RESERVED_RATIO', kind: 'number',
    label: 'Pass 1 — reserved / fulfillable above',
    note: 'How blocked by reservations the FBA stock has to be.' },
  { name: 'AwdFba_Pass1TriggerDoi', path: 'RULES.PASS1_TRIGGER_DOI', kind: 'number',
    label: 'Pass 1 — available-only cover under (DOI)',
    note: 'Measured on the rate named below, not on order_plan_rate.' },
  { name: 'AwdFba_Pass1TargetDoi', path: 'RULES.PASS1_AVAILABLE_DOI', kind: 'number',
    label: 'Pass 1 — top available-only up to (DOI)',
    note: 'Deliberately above the trigger, or filled rows re-trigger.' },
  { name: 'AwdFba_Pass2TriggerDoi', path: 'RULES.PASS2_TRIGGER_DOI', kind: 'number',
    label: 'Pass 2 — B2B / Critical fires under (DOI)',
    note: 'A priority SKU already above this is left alone.' },
  { name: 'AwdFba_MaxDoiAfter', path: 'RULES.MAX_FBA_DOI_AFTER', kind: 'number',
    label: 'Never leave FBA above (DOI)',
    note: 'Cases come off until total FBA cover after the transfer fits.' },
  { name: 'AwdFba_ReviewAboveCases', path: 'RULES.REVIEW_ABOVE_CASES', kind: 'number',
    label: 'Flag for review above (cases)',
    note: 'Proposed, but marked worth a second look.' },

  { section: 'Tactical > FBA' },
  { name: 'TacFba_SpikeMultiplier', path: 'RULES.TAC_TO_FBA_SPIKE_MULTIPLIER', kind: 'number',
    label: 'A case may overshoot the target by',
    note: '1.1 means a target of 100 tolerates a landing at 110.' },
  { name: 'TacFba_DiscontinuedAimDoi', path: 'RULES.DISCONTINUED_AIM_FBA_DOI', kind: 'number',
    label: 'Discontinued — aim for (DOI)',
    note: 'Liquidating, so push stock down towards this.' },
  { name: 'TacFba_DiscontinuedMaxDoi', path: 'RULES.DISCONTINUED_MAX_FBA_DOI', kind: 'number',
    label: 'Discontinued — never exceed (DOI)',
    note: 'If even one case crosses this, send none.' },
  { name: 'TacFba_FloorBreachMaxDoi', path: 'RULES.FLOOR_BREACH_MAX_FBA_DOI', kind: 'number',
    label: 'Tactical floor may be broken under (FBA DOI)',
    note: 'Only here, only when AWD is empty, and only because this lane ships '
      + 'SPD. Tactical > AWD is palletised and may never break it.' },
  { name: 'TacFba_FloorBreachRestoreDoi', path: 'RULES.FLOOR_BREACH_RESTORE_DOI', kind: 'number',
    label: '...and only to restore cover to about (DOI)',
    note: 'Breaking the floor is a rescue, not a top-up. If the transfer would '
      + 'not land near here it is not a rescue and the floor holds.' },
  { name: 'TacFba_FloorBreachTolerance', path: 'RULES.FLOOR_BREACH_RESTORE_TOLERANCE', kind: 'number',
    label: '...give or take',
    note: '0.25 means anywhere from 45 to 75 days counts as restoring 60.' },

  { section: 'Rates' },
  { name: 'Pass1_Rate', path: 'RULES.PASS1_RATE', kind: 'text',
    label: 'Pass 1 measures cover on',
    note: 'true_rate_30 or order_plan_rate. On 08-13 the two differ by three '
      + 'cases on 101-1068; true_rate_30 is what shipped.' },
  { name: 'Contention_FbaDoi', path: 'RULES.FBA_DOI_CONTENTION', kind: 'number',
    label: 'Below this FBA cover, Tactical serves FBA first',
    note: 'Both Tactical lanes draw on one pool. In the sheet, Tactical > FBA '
      + 'is always settled first and its units come off the Tactical > AWD '
      + 'budget — see the README.' },
];

/** Two-column tables that live below the dials. */
var SETTINGS_TABLES = [
  {
    name: 'Fba_MinUnitsBySku',
    path: 'RULES.FBA_MIN_UNITS_BY_SKU',
    title: 'Minimum units to hold at FBA, by SKU',
    headers: ['SKU', 'Units'],
    note: 'Beats every DOI rule. 101-4001 is held at 100 units on a marketing '
      + 'call, and no days-of-cover figure knows that.',
    minRows: 12,
  },
];

/** Cells the tab derives for itself, and the lane formulas read back. */
var SETTINGS_RUN_CELLS = [
  {
    name: 'Run_TacAwdQualifyingCases',
    label: 'Tactical > AWD — cases that qualify',
    formula: function (cfg) {
      var col = colLetter(laneWorkColumns(cfg, 'TAC_TO_AWD').QUALIFY);
      return '=SUM(' + quoteTab(cfg.TABS.TAC_TO_AWD) + '!'
        + col + cfg.LAYOUT.LANE_FIRST_DATA_ROW + ':' + col + ')';
    },
    note: 'Demand before the pallet test, summed straight off the lane.',
  },
  {
    name: 'Run_TacAwdVerdict',
    label: 'Tactical > AWD — raise this run?',
    formula: function () {
      return '=IF(' + SETTINGS_NAMES.RUN_TAC_AWD_QUALIFYING + '>='
        + SETTINGS_NAMES.PALLET_MIN + ',"RAISE","HOLD")';
    },
    note: 'HOLD zeroes the whole lane. Raise the pallet minimum and watch the '
      + 'column empty; lower it and watch it fill.',
  },
];

// ------------------------------------------------------------------- building

/**
 * Create or rebuild the Settings tab and its named ranges.
 *
 * Values already on the tab are kept — that is the whole point, since Marco
 * edits them. Only labels, notes and layout are rewritten, so a renamed dial
 * or a new one appears without wiping the numbers next to the old ones.
 */
function ensureSettings(planner, cfg) {
  var ss = planner || SpreadsheetApp.getActiveSpreadsheet();
  // The run cells name a lane tab inside a formula, so they need the
  // workbook's own spelling rather than the configured one.
  var conf = resolveTabNames(ss, cfg || config());
  var name = conf.TABS.SETTINGS;

  var sh = sheetByName(ss, name);
  if (!sh) sh = ss.insertSheet(name);
  if (!isGridSheet(sh)) {
    throw new Error('"' + name + '" is a Connected Sheet; the planner needs an '
      + 'ordinary tab there.');
  }

  var existing = readSettingsCells(sh);
  var plan = layoutSettings(conf);

  var width = 3;
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  if (sh.getMaxRows() < plan.rows.length) {
    sh.insertRowsAfter(sh.getMaxRows(), plan.rows.length - sh.getMaxRows());
  }

  // Keep whatever the sheet already held for a dial; fall back to Config.
  plan.dials.forEach(function (d) {
    if (d.kind === 'formula') return;
    var was = existing[d.name];
    if (was !== undefined && was !== null && was !== '') {
      plan.rows[d.row - 1][1] = was;
    }
  });
  plan.tables.forEach(function (t) {
    var was = existing['@' + t.name];
    if (!was || !was.length) return;
    for (var i = 0; i < t.height && i < was.length; i++) {
      plan.rows[t.row - 1 + i][0] = was[i][0];
      plan.rows[t.row - 1 + i][1] = was[i][1];
    }
  });

  sh.getRange(1, 1, plan.rows.length, width).clearContent();
  sh.getRange(1, 1, plan.rows.length, width).setValues(plan.rows);

  // The derived cells go in last, as formulas rather than values.
  plan.dials.forEach(function (d) {
    if (d.kind !== 'formula') return;
    sh.getRange(d.row, 2).setFormula(d.formula(conf));
  });

  styleSettings(sh, plan, conf);
  nameSettingsRanges(ss, sh, plan);

  return { sheet: sh, dials: plan.dials.length, tables: plan.tables.length };
}

/**
 * Where every row goes. Pure — no sheet involved — so the layout is testable
 * and the named ranges cannot drift from what was written.
 */
function layoutSettings(cfg) {
  var rows = [];
  var dials = [];
  var tables = [];

  function push(a, b, c) { rows.push([a, b === undefined ? '' : b, c || '']); return rows.length; }

  push('US transfer order planner — settings', '', '');
  push('Edit a value in column B and every lane recalculates. Nothing here is '
    + 'overwritten by a run.', '', '');
  push('', '', '');
  push('Setting', 'Value', 'What it changes');

  SETTINGS_DIALS.forEach(function (d) {
    if (d.section) { push('', '', ''); push(d.section, '', ''); return; }
    var row = push(d.label, getByPath_(cfg, d.path), d.note);
    dials.push({ name: d.name, path: d.path, kind: d.kind, row: row });
  });

  push('', '', '');
  push('This run', '', '');
  SETTINGS_RUN_CELLS.forEach(function (c) {
    var row = push(c.label, '', c.note);
    dials.push({ name: c.name, kind: 'formula', row: row, formula: c.formula });
  });

  SETTINGS_TABLES.forEach(function (t) {
    push('', '', '');
    push(t.title, '', t.note);
    push(t.headers[0], t.headers[1], '');
    var entries = Object.keys(getByPath_(cfg, t.path) || {}).map(function (k) {
      return [k, getByPath_(cfg, t.path)[k]];
    });
    var height = Math.max(t.minRows, entries.length + 4);
    var first = rows.length + 1;
    for (var i = 0; i < height; i++) {
      push(entries[i] ? entries[i][0] : '', entries[i] ? entries[i][1] : '', '');
    }
    tables.push({ name: t.name, path: t.path, row: first, height: height });
  });

  push('', '', '');
  push('Defaults live in Config.gs. Clearing a value here restores the default '
    + 'on the next run.', '', '');

  return { rows: rows, dials: dials, tables: tables };
}

function styleSettings(sh, plan, cfg) {
  var width = 3;
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1, 1, width).setFontStyle('italic').setFontColor('#666666');
  sh.getRange(4, 1, 1, width).setFontWeight('bold').setBackground(cfg.COLOURS.HEADER);

  // Section rows: the ones with a label and nothing beside it.
  var bold = [];
  plan.rows.forEach(function (r, i) {
    if (i < 4) return;
    if (r[0] && r[1] === '' && r[2] === '') bold.push(i + 1);
  });
  bold.forEach(function (r) {
    sh.getRange(r, 1, 1, width).setFontWeight('bold').setBackground('#f3f3f3');
  });

  plan.dials.forEach(function (d) {
    var cell = sh.getRange(d.row, 2);
    cell.setBackground(d.kind === 'formula' ? '#efefef' : '#fff2cc');
    if (d.kind === 'formula') cell.setFontWeight('bold');
  });
  plan.tables.forEach(function (t) {
    sh.getRange(t.row, 1, t.height, 2).setBackground('#fff2cc');
  });

  sh.setColumnWidth(1, 320);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 620);
  sh.getRange(1, 3, plan.rows.length, 1).setWrap(true);
  sh.setFrozenRows(4);
}

/**
 * Point each name at its cell — **in place**, never by removing it first.
 *
 * Removing a named range in Sheets is destructive to everything that used it:
 * every formula referencing the name is rewritten, on the spot, with the
 * literal text `#REF!`. Re-creating the name a moment later does not undo
 * that — the formulas have already been edited.
 *
 * This ran on every plan, so every run began by shredding the lane formulas
 * the previous run had written. It self-repaired whenever writeAllFormulas()
 * got as far as rewriting the lane, and did not when it didn't, which is why
 * AWD > FBA came back full of
 *
 *   ROUNDUP((#REF!-N($Y8))*...        where AwdFba_Pass1TargetDoi had been
 *   IF(N($J8)+N($O8)<#REF!,...        where Dss_BaselineDoi had been
 *
 * `setRange()` moves an existing name without touching a single formula.
 */
function nameSettingsRanges(ss, sh, plan) {
  var wanted = {};
  plan.dials.forEach(function (d) { wanted[d.name] = sh.getRange(d.row, 2); });
  plan.tables.forEach(function (t) {
    wanted[t.name] = sh.getRange(t.row, 1, t.height, 2);
  });

  var existing = {};
  ss.getNamedRanges().forEach(function (nr) { existing[nr.getName()] = nr; });

  var moved = 0;
  var created = 0;
  Object.keys(wanted).forEach(function (name) {
    var range = wanted[name];
    var nr = existing[name];
    if (!nr) {
      ss.setNamedRange(name, range);
      created++;
      return;
    }
    // Only move it if it is actually somewhere else; setRange() is cheap but
    // a no-op write is still a write.
    var was;
    try { was = nr.getRange().getA1Notation(); } catch (e) { was = null; }
    if (was !== range.getA1Notation()
        || (nr.getRange().getSheet().getSheetId() !== sh.getSheetId())) {
      nr.setRange(range);
      moved++;
    }
  });
  return { moved: moved, created: created };
}

// -------------------------------------------------------------------- reading

/** Whatever is currently sitting in each named cell, by name. */
function readSettingsCells(sh) {
  var out = {};
  var ss = sh.getParent();
  ss.getNamedRanges().forEach(function (nr) {
    var rng = nr.getRange();
    if (rng.getSheet().getSheetId() !== sh.getSheetId()) return;
    try {
      if (rng.getNumRows() === 1 && rng.getNumColumns() === 1) {
        // A derived cell holds a formula; its value is not a setting.
        if (rng.getFormula()) return;
        out[nr.getName()] = rng.getValue();
      } else {
        out['@' + nr.getName()] = rng.getValues();
      }
    } catch (e) { /* a name pointing at a deleted range */ }
  });
  return out;
}

/**
 * Config with the Settings tab applied on top.
 *
 * This is what makes the tab real rather than decorative: the rule engine and
 * the sheet formulas both end up working from the numbers in column B, so a
 * dial changed there moves both at once and they cannot disagree.
 *
 * Script Properties still win over Config defaults; the tab wins over both,
 * because it is the one a human can see.
 */
function configFor(planner, base) {
  var cfg = base || config();
  var ss = planner;
  if (!ss) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return cfg; }
  }
  var sh = sheetByName(ss, cfg.TABS.SETTINGS);
  if (!sh || !isGridSheet(sh)) return cfg;

  var cells = readSettingsCells(sh);
  var byName = {};
  SETTINGS_DIALS.forEach(function (d) { if (d.name) byName[d.name] = d; });

  Object.keys(byName).forEach(function (name) {
    var d = byName[name];
    var v = cells[name];
    if (v === undefined || v === null || v === '') return;
    if (d.kind === 'number') {
      var n = Number(v);
      if (!isFinite(n)) return;
      setByPath(cfg, d.path, n);
    } else {
      setByPath(cfg, d.path, String(v).trim());
    }
  });

  SETTINGS_TABLES.forEach(function (t) {
    var grid = cells['@' + t.name];
    if (!grid) return;
    var map = {};
    grid.forEach(function (row) {
      var k = normSku(row[0]);
      var n = Number(row[1]);
      if (k && isFinite(n) && n > 0) map[k] = n;
    });
    // An empty table means "no per-SKU floors", which is a real answer.
    setByPath(cfg, t.path, map);
  });

  cfg.SETTINGS_APPLIED = true;
  return cfg;
}
