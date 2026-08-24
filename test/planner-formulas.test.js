/**
 * The formulas the planner writes, evaluated.
 *
 * Two things are being checked, and the second is the one that matters:
 *
 *  1. that the formulas parse and mean what they look like — the Tactical
 *     floor really does cap the draw, an unreadable figure really does stop a
 *     row rather than reading as zero;
 *
 *  2. that they agree with Rules_*.gs on the same inputs. The planner keeps
 *     both, and two implementations of one set of rules drift unless something
 *     compares them. This is that something.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppsScript, tacAwdRow, awdFbaRow, tacFbaRow } from './helpers/load-gs.js';
import { buildWorkbook, sheetCases, namedRanges, harmonise } from './helpers/lane-grid.js';
import { Workbook, parseFormula, evaluate, SheetError } from './helpers/sheet-eval.js';

const gs = loadAppsScript();
const { context: G } = gs;

const cfg = () => G.config();

/** Evaluate one lane and return the cases the sheet would show. */
function casesFor(lanes, over) {
  const c = cfg();
  if (over) over(c);
  const wb = buildWorkbook(gs, c, lanes);
  return {
    wb,
    cfg: c,
    tacToAwd: sheetCases(wb, c, 'TAC_TO_AWD', lanes.tacToAwd || []),
    awdToFba: sheetCases(wb, c, 'AWD_TO_FBA', lanes.awdToFba || []),
    tacToFba: sheetCases(wb, c, 'TAC_TO_FBA', lanes.tacToFba || []),
  };
}

const cell = (wb, c, laneKey, col, row) =>
  wb.value(c.TABS[laneKey], row, col);

// ------------------------------------------------------- the evaluator itself

test('the evaluator handles the constructs the planner emits', () => {
  const wb = new Workbook({ S: [['', 5, 'text']] }, { Dial: 7 });
  const run = (f) => evaluate(parseFormula(f), wb, 'S', 1);

  assert.equal(run('=1+2*3'), 7);
  assert.equal(run('=(1+2)*3'), 9);
  assert.equal(run('=MAX(0,MIN(4,9))'), 4);
  assert.equal(run('=ROUNDUP(2.1,0)'), 3);
  assert.equal(run('=FLOOR(112/12)'), 9);
  assert.equal(run('=IF($B1>3,"big","small")'), 'big');
  assert.equal(run('=N($C1)'), 0, 'text reads as zero, as N() does');
  assert.equal(run('=$A1=""'), true, 'a blank cell equals the empty string');
  assert.equal(run('=Dial*2'), 14);
  assert.equal(run('=LOWER(TRIM($C1&""))="text"'), true);
  assert.ok(evaluate(parseFormula('=Missing'), wb, 'S', 1) instanceof SheetError);
  assert.equal(run('=IFERROR(Missing,42)'), 42);
});

// ------------------------------------------------------ lane: Tactical > AWD

test('Tactical > AWD: the floor caps the draw, in cases, on the sheet', () => {
  // 112 units at Tactical, a floor of 100, cases of 12: one case may move.
  const rows = [tacAwdRow({
    sku: '101-2040', tacAvailableUnits: 112, minUnits: 100, caseQty: 12,
    rate: 5, awdQty: 0, awdInbound14: 0, fbaDoi: 30,
  })];
  const r = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 1; });
  const W = G.laneWorkColumns(r.cfg, 'TAC_TO_AWD');

  assert.equal(cell(r.wb, r.cfg, 'TAC_TO_AWD', W.DRAWABLE, 8), 1,
    'the drawable column shows what the floor allows');
  assert.equal(r.tacToAwd[0], 1, 'and the transfer column never exceeds it');
});

test('Tactical > AWD: a floor bigger than the stock sends nothing', () => {
  const rows = [tacAwdRow({
    tacAvailableUnits: 100, minUnits: 100, caseQty: 12, rate: 5,
    awdQty: 0, fbaDoi: 20,
  })];
  const r = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 1; });
  assert.equal(r.tacToAwd[0], 0);
});

test('Tactical > AWD: an unreadable Tactical floor draws nothing', () => {
  const rows = [tacAwdRow({
    tacAvailableUnits: 1000, minUnits: 0, caseQty: 12, rate: 5,
    awdQty: 0, fbaDoi: 20,
  })];
  const c = cfg();
  c.RULES.PALLET_MIN_CASES = 1;
  const wb = buildWorkbook(gs, c, { tacToAwd: rows });
  // An error in column B, as an unauthorised IMPORTRANGE leaves one.
  wb.sheets[c.TABS.TAC_TO_AWD][7][c.COLS.TAC_TO_AWD.MIN_UNITS] = '=Unauthorised';
  wb.cache.clear();

  assert.equal(sheetCases(wb, c, 'TAC_TO_AWD', rows)[0], 0,
    'a floor that cannot be read is not a floor of zero');
});

test('Tactical > AWD: FBA healthy at 599 DOI is not an emergency', () => {
  const rows = [tacAwdRow({
    sku: '101-2102', awdQty: 0, awdInbound14: 0, rate: 0.17,
    tacAvailableUnits: 5000, caseQty: 12, fbaDoi: 599,
  })];
  const r = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 1; });
  assert.equal(r.tacToAwd[0], 0, 'no AWD stock, but months of cover at FBA');
});

test('Tactical > AWD: an FBA figure that is not a number stops the row', () => {
  const rows = [tacAwdRow({
    awdQty: 0, rate: 5, tacAvailableUnits: 1000, caseQty: 12, fbaDoi: 'No Rate',
  })];
  const r = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 1; });
  assert.equal(r.tacToAwd[0], 0, '"No Rate" must not read as nought days of cover');
});

test('Tactical > AWD: the pallet minimum holds the whole run, not the row', () => {
  const rows = [tacAwdRow({
    sku: 'A', awdQty: 0, rate: 5, tacAvailableUnits: 1000, caseQty: 12, fbaDoi: 30,
  })];

  const held = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 999; });
  assert.equal(held.tacToAwd[0], 0, 'below the pallet minimum, nothing ships');
  assert.equal(
    cell(held.wb, held.cfg, 'TAC_TO_AWD',
      G.laneWorkColumns(held.cfg, 'TAC_TO_AWD').QUALIFY, 8) > 0, true,
    'though the qualifying column still shows what wanted to move');

  const sent = casesFor({ tacToAwd: rows }, (c) => { c.RULES.PALLET_MIN_CASES = 1; });
  assert.ok(sent.tacToAwd[0] > 0, 'and raising the run releases it');
});

test('Tactical > AWD: a dial change reprices the column', () => {
  const rows = [tacAwdRow({
    awdQty: 100, awdInbound14: 0, rate: 5, tacAvailableUnits: 10000,
    caseQty: 10, fbaDoi: 30, minUnits: 0,
  })];
  const at75 = casesFor({ tacToAwd: rows }, (c) => {
    c.RULES.PALLET_MIN_CASES = 1; c.RULES.TAC_TO_AWD_TARGET_DOI = 75;
  });
  const at90 = casesFor({ tacToAwd: rows }, (c) => {
    c.RULES.PALLET_MIN_CASES = 1; c.RULES.TAC_TO_AWD_TARGET_DOI = 90;
  });
  assert.ok(at90.tacToAwd[0] > at75.tacToAwd[0],
    'raising the target on the Settings tab raises the quantity');
});

// ---------------------------------------------------------- lane: AWD > FBA

test('AWD > FBA: the sheet picks the same pass the rules do', () => {
  const rows = [
    awdFbaRow({ sku: 'P1', amzFulfillable: 100, amzReserved: 400, amzTotal: 500,
      amzDoi: 50, rate: 10, trueRate30: 10, caseQty: 20 }),
    awdFbaRow({ sku: 'P2', b2b: true, amzFulfillable: 300, amzTotal: 300,
      amzDoi: 30, rate: 10, trueRate30: 10, caseQty: 20 }),
    awdFbaRow({ sku: 'P3', amzFulfillable: 200, amzTotal: 200, amzDoi: 20,
      rate: 10, trueRate30: 10, caseQty: 20 }),
  ];
  const r = casesFor({ awdToFba: rows });
  const W = G.laneWorkColumns(r.cfg, 'AWD_TO_FBA');
  assert.equal(cell(r.wb, r.cfg, 'AWD_TO_FBA', W.PASS, 8), 1, 'reserved-blocked');
  assert.equal(cell(r.wb, r.cfg, 'AWD_TO_FBA', W.PASS, 9), 2, 'B2B');
  assert.equal(cell(r.wb, r.cfg, 'AWD_TO_FBA', W.PASS, 10), 3, 'baseline');
});

test('AWD > FBA: nothing is left above the 110-day ceiling', () => {
  const rows = [awdFbaRow({
    b2b: true, amzFulfillable: 900, amzTotal: 900, amzDoi: 90, rate: 10,
    trueRate30: 10, caseQty: 20, awdAvailableUnits: 10000,
  })];
  const r = casesFor({ awdToFba: rows });
  const after = cell(r.wb, r.cfg, 'AWD_TO_FBA', r.cfg.COLS.AWD_TO_FBA.AMZ_DOI_AFTER, 8);
  assert.ok(after <= r.cfg.RULES.MAX_FBA_DOI_AFTER + 1e-9,
    `left FBA at ${after} DOI`);
});

test('AWD > FBA: pass 1 measures cover on true_rate_30', () => {
  // Fulfillable 100 against a true rate of 5 is 20 days; against an order plan
  // rate of 2 it would be 50 and the row would not qualify at all.
  const rows = [awdFbaRow({
    amzFulfillable: 100, amzReserved: 400, amzTotal: 500, amzDoi: 250,
    rate: 2, trueRate30: 5, caseQty: 10, awdAvailableUnits: 10000,
  })];
  const r = casesFor({ awdToFba: rows });
  const y = cell(r.wb, r.cfg, 'AWD_TO_FBA', r.cfg.COLS.AWD_TO_FBA.AVAILABLE_ONLY_DOI, 8);
  assert.equal(y, 20, 'column Y shows the number pass 1 actually reads');
});

// ------------------------------------------------------ lane: Tactical > FBA

test('Tactical > FBA: stays shut while AWD is covering the shortfall', () => {
  const shared = {
    sku: 'S1', rate: 10, trueRate30: 10, caseQty: 20,
    amzFulfillable: 300, amzTotal: 300, amzDoi: 30,
  };
  const r = casesFor({
    awdToFba: [awdFbaRow({ ...shared, awdAvailableUnits: 10000 })],
    tacToFba: [tacFbaRow({ ...shared, awdAvailableUnits: 10000,
      tacAvailableUnits: 1000, minUnits: 0 })],
  });
  assert.ok(r.awdToFba[0] > 0, 'AWD is sending');
  assert.equal(r.tacToFba[0], 0, 'so Tactical stays out of it');
});

test('Tactical > FBA: opens when AWD has nothing, and respects the floor', () => {
  const r = casesFor({
    tacToFba: [tacFbaRow({
      sku: 'S2', rate: 10, trueRate30: 10, caseQty: 20, awdAvailableUnits: 0,
      amzFulfillable: 300, amzTotal: 300, amzDoi: 30,
      tacAvailableUnits: 300, minUnits: 200,
    })],
  });
  assert.equal(r.tacToFba[0], 5, '100 units above the floor, 20 to a case');
});

test('Tactical > FBA: a per-SKU unit floor beats the DOI rules', () => {
  const r = casesFor({
    tacToFba: [tacFbaRow({
      sku: '101-4001', rate: 1, trueRate30: 1, caseQty: 1, awdAvailableUnits: 0,
      amzFulfillable: 55, amzTotal: 55, amzDoi: 55,
      tacAvailableUnits: 1000, minUnits: 0,
    })],
  });
  assert.equal(r.tacToFba[0], 45, '55 units at FBA, held at 100');
});

test('Tactical > FBA: discontinued stock never crosses 110 days', () => {
  const r = casesFor({
    tacToFba: [tacFbaRow({
      sku: 'D1', lifecycle: 'Discontinued', rate: 1, trueRate30: 1, caseQty: 100,
      awdAvailableUnits: 0, amzFulfillable: 60, amzTotal: 60, amzDoi: 60,
      tacAvailableUnits: 1000, minUnits: 0,
    })],
  });
  assert.equal(r.tacToFba[0], 0, 'one 100-unit case would reach 160 DOI');
});

// ------------------------------------- the sheet and the rules, side by side

/**
 * The check the whole design rests on. Every scenario runs through both
 * implementations and the answers have to match.
 */
const SCENARIOS = [
  {
    name: 'a quiet week',
    awdToFba: [
      awdFbaRow({ sku: 'A1', amzFulfillable: 900, amzTotal: 900, amzDoi: 90 }),
      awdFbaRow({ sku: 'A2', amzFulfillable: 600, amzTotal: 600, amzDoi: 60 }),
    ],
  },
  {
    name: 'reserved-blocked and priority together',
    awdToFba: [
      awdFbaRow({ sku: 'B1', amzFulfillable: 100, amzReserved: 400,
        amzTotal: 500, amzDoi: 50, trueRate30: 10 }),
      awdFbaRow({ sku: 'B2', b2b: true, amzFulfillable: 200, amzTotal: 200,
        amzDoi: 20 }),
      awdFbaRow({ sku: 'B3', critical: true, amzFulfillable: 50, amzTotal: 50,
        amzDoi: 5, awdAvailableUnits: 100, availableCases: 5 }),
    ],
  },
  {
    name: 'the ladder at its edges',
    awdToFba: [
      awdFbaRow({ sku: 'C1', awdDoi: 10, amzTotal: 100, amzDoi: 10,
        amzFulfillable: 100, awdAvailableUnits: 200, availableCases: 10 }),
      awdFbaRow({ sku: 'C2', amzTotal: 600, amzDoi: 60, amzFulfillable: 600 }),
      awdFbaRow({ sku: 'C3', amzTotal: 595, amzDoi: 59.5, amzFulfillable: 595 }),
    ],
  },
  {
    name: 'no rate, no case size',
    awdToFba: [
      awdFbaRow({ sku: 'D1', rate: 0, trueRate30: 0 }),
      awdFbaRow({ sku: 'D2', caseQty: 0 }),
    ],
  },
];

for (const s of SCENARIOS) {
  test(`AWD > FBA sheet and rules agree — ${s.name}`, () => {
    const c = cfg();
    const rows = harmonise('AWD_TO_FBA', s.awdToFba);
    const rules = G.planAwdToFba(rows, c, {}).map((d) => Math.max(0, d.cases));
    const sheet = sheetCases(buildWorkbook(gs, c, { awdToFba: rows }), c,
      'AWD_TO_FBA', rows);
    assert.deepEqual(sheet, rules,
      rows.map((r, i) => `${r.sku}: sheet ${sheet[i]}, rules ${rules[i]}`).join('\n'));
  });
}

test('Tactical > AWD sheet and rules agree on a full run', () => {
  const c = cfg();
  c.RULES.PALLET_MIN_CASES = 1;   // judge the quantities, not the pallet test
  const rows = harmonise('TAC_TO_AWD', [
    tacAwdRow({ sku: 'E1', awdQty: 100, rate: 5, caseQty: 10,
      tacAvailableUnits: 1000, minUnits: 0, fbaDoi: 30 }),
    tacAwdRow({ sku: 'E2', awdQty: 112, rate: 5, caseQty: 12,
      tacAvailableUnits: 112, minUnits: 100, fbaDoi: 40 }),
    tacAwdRow({ sku: 'E3', awdQty: 6000, rate: 10, caseQty: 20,
      tacAvailableUnits: 500, minUnits: 0, fbaDoi: 30 }),
    tacAwdRow({ sku: 'E4', lifecycle: 'Discontinued', awdQty: 0, rate: 5,
      caseQty: 10, tacAvailableUnits: 500, minUnits: 0, fbaDoi: 10 }),
    tacAwdRow({ sku: 'E5', awdQty: 0, rate: 5, caseQty: 10,
      tacAvailableUnits: 500, minUnits: 0, fbaDoi: 200 }),
    tacAwdRow({ sku: 'E6', awdQty: 50, rate: 5, caseQty: 12,
      tacAvailableUnits: 112, minUnits: 100, fbaDoi: 20 }),
  ]);

  const rules = G.planTacToAwd(rows, c, {}).map((d) => Math.max(0, d.cases));
  const sheet = sheetCases(buildWorkbook(gs, c, { tacToAwd: rows }), c,
    'TAC_TO_AWD', rows);
  assert.deepEqual(sheet, rules,
    rows.map((r, i) => `${r.sku}: sheet ${sheet[i]}, rules ${rules[i]}`).join('\n'));
});

test('Tactical > FBA sheet and rules agree on a residual run', () => {
  const c = cfg();
  const awd = harmonise('AWD_TO_FBA', [
    // Covered by AWD: the residual lane must stay shut.
    awdFbaRow({ sku: 'F1', amzFulfillable: 200, amzInbound: 0, rate: 10,
      trueRate30: 10, caseQty: 20, awdAvailableUnits: 4000 }),
    // AWD is dry: the residual lane opens.
    awdFbaRow({ sku: 'F2', amzFulfillable: 200, rate: 10, trueRate30: 10,
      caseQty: 20, awdAvailableUnits: 0 }),
  ]);
  const tac = harmonise('TAC_TO_FBA', [
    tacFbaRow({ sku: 'F1', amzFulfillable: 200, rate: 10, trueRate30: 10,
      caseQty: 20, awdAvailableUnits: 4000, tacAvailableUnits: 1000, minUnits: 0 }),
    tacFbaRow({ sku: 'F2', amzFulfillable: 200, rate: 10, trueRate30: 10,
      caseQty: 20, awdAvailableUnits: 0, tacAvailableUnits: 1000, minUnits: 800 }),
    // Not on the AWD lane at all, and AWD holds stock: still shut.
    tacFbaRow({ sku: 'F3', amzFulfillable: 100, rate: 10, trueRate30: 10,
      caseQty: 20, awdAvailableUnits: 500, tacAvailableUnits: 1000, minUnits: 0 }),
  ]);

  const awdDec = G.planAwdToFba(awd, c, {});
  const awdBySku = {};
  awd.forEach((r, i) => {
    awdBySku[G.normSku(r.sku)] = {
      cases: awdDec[i].cases,
      cappedByAwdStock: !!awdDec[i].cappedByAwdStock,
      shortfallCases: awdDec[i].shortfallCases || 0,
      awdAvailableUnits: r.awdAvailableUnits,
    };
  });

  const dec = G.planTacToFba(tac, c, {}, awdBySku, {});
  // The floor lives inside the formula but in Allocate.gs on the rule path, so
  // run the real allocator rather than approximating it — otherwise the test
  // measures the approximation.
  G.allocateTactical([], [], tac, dec, c);
  const rules = dec.map((d) => Math.max(0, d.cases));

  const wb = buildWorkbook(gs, c, { awdToFba: awd, tacToFba: tac });
  const sheet = sheetCases(wb, c, 'TAC_TO_FBA', tac);
  assert.deepEqual(sheet, rules,
    tac.map((r, i) => `${r.sku}: sheet ${sheet[i]}, rules ${rules[i]}`).join('\n'));
});

test('Tactical > FBA: the floor holds when the transfer is not a rescue', () => {
  // AWD is empty and FBA is on 20 days, so the first two breach conditions
  // hold. But this SKU is filling to its 100-unit floor, which lands FBA on
  // 100 days of cover — a top-up, not the rescue §7.1 exists for. So the
  // Tactical floor holds and only the 10 units above it move.
  const c = cfg();
  const rows = harmonise('TAC_TO_FBA', [tacFbaRow({
    sku: '101-4001', rate: 1, trueRate30: 1, caseQty: 1, awdAvailableUnits: 0,
    amzFulfillable: 20, amzInbound: 0, amzReserved: 0,
    tacAvailableUnits: 1000, minUnits: 990,
  })]);
  const wb = buildWorkbook(gs, c, { tacToFba: rows });
  const W = G.laneWorkColumns(c, 'TAC_TO_FBA');

  assert.equal(cell(wb, c, 'TAC_TO_FBA', W.PROPOSED, 8), 80,
    'it wants 80 units to reach the floor');
  assert.equal(sheetCases(wb, c, 'TAC_TO_FBA', rows)[0], 10,
    'and gets the 10 the Tactical floor leaves');
});

// ------------------------------------------------------------------ plumbing

test('every name a formula references is defined on the Settings tab', () => {
  const c = cfg();
  const defined = new Set(Object.keys(namedRanges(gs, c))
    .concat(G.SETTINGS_RUN_CELLS.map((r) => r.name)));

  const used = new Set();
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const built = G.LANE_FORMULA_BUILDERS[lane](8, c);
    Object.values(built).forEach((f) => {
      collectNames(parseFormula(f), used);
    });
  });

  assert.ok(used.size > 0, 'the formulas reference the Settings tab at all');
  for (const name of used) {
    assert.ok(defined.has(name), `${name} is used by a formula but never defined`);
  }
});

function collectNames(node, into) {
  if (!node || typeof node !== 'object') return;
  if (node.t === 'name') into.add(node.name);
  (node.args || []).forEach((a) => collectNames(a, into));
  collectNames(node.left, into);
  collectNames(node.right, into);
  collectNames(node.arg, into);
}

test('SETTINGS_NAMES and the Settings tab agree, both ways', () => {
  const declared = new Set(Object.values(G.SETTINGS_NAMES));
  const onTab = new Set(
    G.SETTINGS_DIALS.filter((d) => d.name).map((d) => d.name)
      .concat(G.SETTINGS_TABLES.map((t) => t.name))
      .concat(G.SETTINGS_RUN_CELLS.map((r) => r.name)));

  for (const n of declared) assert.ok(onTab.has(n), `${n} is declared but not on the tab`);
  for (const n of onTab) assert.ok(declared.has(n), `${n} is on the tab but not declared`);
});

test('the work columns sit clear of the lane data', () => {
  const c = cfg();
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const used = Object.values(c.COLS[lane]);
    const work = Object.values(G.laneWorkColumns(c, lane));
    work.forEach((col) => {
      assert.ok(!used.includes(col),
        `${lane}: work column ${col} lands on a data column`);
      assert.ok(col > c.COLS[lane].REASON, `${lane}: work column ${col} is left of Reason`);
    });
    assert.equal(new Set(work).size, work.length, `${lane}: work columns collide`);
  });
});

test('the refresh leaves every calculated column alone', () => {
  const c = cfg();
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const owned = G.formulaColumns(lane, c);
    assert.ok(owned.includes(c.COLS[lane].CASES_OUT),
      `${lane}: the transfer column must never be pasted over`);
    assert.ok(owned.includes(c.COLS[lane].UNITS_OUT),
      `${lane}: the units column must never be pasted over`);
    assert.ok(owned.includes(c.COLS[lane].REASON),
      `${lane}: the reason column must never be pasted over`);
    assert.ok(!owned.includes(c.COLS[lane].NAME),
      `${lane}: the SKU is an input and has to be refreshed`);
    assert.ok(!owned.includes(c.COLS[lane].CASE_QTY),
      `${lane}: the case size is an input and has to be refreshed`);
  });
});

test('the Tactical minimum is never pasted over', () => {
  const c = cfg();
  assert.ok(c.REFRESH.PRESERVE_COLS.TAC_TO_AWD.includes(c.COLS.TAC_TO_AWD.MIN_UNITS));
  assert.ok(c.REFRESH.PRESERVE_COLS.TAC_TO_FBA.includes(c.COLS.TAC_TO_FBA.MIN_UNITS));
});

test('two lanes pinned to one IMS tab is refused', () => {
  assert.equal(G.duplicateLaneTabs({
    TAC_TO_AWD: 'US TO Tactical > AWD',
    AWD_TO_FBA: 'US TO AWD > FBA',
    TAC_TO_FBA: 'US TO Tactical > FBA',
  }), null);
  assert.equal(G.duplicateLaneTabs({
    TAC_TO_AWD: 'US TO AWD > FBA',
    AWD_TO_FBA: 'US TO AWD > FBA',
    TAC_TO_FBA: 'US TO Tactical > FBA',
  }), 'US TO AWD > FBA', 'the 08-24 failure, caught before it writes anything');
});

test('the three IMS lane tabs are pinned, not guessed', () => {
  const c = cfg();
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((k) => {
    assert.ok(c.SOURCES.IMS_LANE_TABS[k], `${k} has no pinned IMS tab`);
  });
});

test('the Settings layout puts every dial on its own row', () => {
  const c = cfg();
  const plan = G.layoutSettings(c);
  const rows = new Set();
  plan.dials.forEach((d) => {
    assert.ok(!rows.has(d.row), `two dials share row ${d.row}`);
    rows.add(d.row);
  });
  plan.dials.forEach((d) => {
    if (d.kind === 'formula') return;
    assert.equal(plan.rows[d.row - 1][1], G.getByPath_(c, d.path),
      `${d.name} was laid out with the wrong default`);
  });
  plan.tables.forEach((t) => {
    assert.ok(t.height > 0);
    assert.ok(plan.rows[t.row - 1], `${t.name} starts past the end of the tab`);
  });
});

// ------------------------------------------------- the floor, from two sources

test('the Tactical floor takes the larger of its two sources', () => {
  const f = (book, cell) => G.resolveFloor(book, cell);

  // 08-24: the B2B tab held 100 for 101-2003, column B showed 100, and the run
  // drew against nothing. A blank in the workbook must never win.
  assert.equal(f('', 100).units, 100, 'a blank in the workbook loses to a visible 100');
  assert.equal(f(0, 100).units, 100, 'and so does an explicit zero');
  assert.equal(f(100, '').units, 100, 'a blank column B loses to the workbook');
  assert.equal(f(100, '#REF!').units, 100, 'an unauthorised IMPORTRANGE loses too');

  assert.equal(f(300, 300).units, 300, 'agreement is the ordinary case');
  assert.equal(f(undefined, '').units, 0, 'a SKU with no floor anywhere has none');

  assert.equal(f(undefined, '#REF!').units, null,
    'but a floor that should be there and cannot be read stays unknown');
  assert.equal(f(undefined, '#REF!').unknown, true);

  const clash = f(100, 300);
  assert.equal(clash.units, 300, 'the larger wins');
  assert.equal(clash.disagreed, true, 'and the disagreement is recorded');
});

test('a SKU holding exactly its floor sends nothing on either implementation', () => {
  // 101-2003 on 08-24: 100 units at Tactical, a floor of 100, cases of 20.
  const c = cfg();
  c.RULES.PALLET_MIN_CASES = 1;
  const rows = harmonise('TAC_TO_AWD', [tacAwdRow({
    sku: '101-2003', tacAvailableUnits: 100, minUnits: 100, caseQty: 20,
    rate: 5.4, awdQty: 100, awdInbound14: 0, fbaDoi: 85,
  })]);

  const rules = G.planTacToAwd(rows, c, {}).map((d) => Math.max(0, d.cases));
  const sheet = sheetCases(buildWorkbook(gs, c, { tacToAwd: rows }), c,
    'TAC_TO_AWD', rows);
  assert.deepEqual(sheet, [0]);
  assert.deepEqual(rules, [0]);
});
