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

// ------------------------------------------------- no circular dependencies

/**
 * The check that would have caught the #REF! on 09-09.
 *
 * Google Sheets resolves open ranges at range granularity, not cell
 * granularity. Two lanes each holding a wide `Sheet!$D:$S`-style lookup into
 * the other are called circular even when no individual cell forms a loop, and
 * the whole transfer column reads #REF!. So the test is deliberately as coarse
 * as Sheets is: build the dependency graph at **column** granularity and
 * require it to be acyclic.
 */
function columnDeps(node, sheet, into) {
  if (!node || typeof node !== 'object') return;
  const tab = node.sheet || sheet;
  if (node.t === 'cell') into.add(`${tab}!${node.col}`);
  if (node.t === 'colrange' || node.t === 'cellrange') {
    const from = node.from.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    const to = node.to.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    for (let i = from; i <= to; i++) {
      let s = '';
      let n = i;
      while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
      into.add(`${tab}!${s}`);
    }
  }
  if (node.t === 'name') into.add(`@${node.name}`);
  (node.args || []).forEach((a) => columnDeps(a, sheet, into));
  columnDeps(node.left, sheet, into);
  columnDeps(node.right, sheet, into);
  columnDeps(node.arg, sheet, into);
}

test('the lane formulas contain no circular dependency, column by column', () => {
  const c = cfg();
  const graph = new Map();

  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const tab = c.TABS[lane];
    const built = G.LANE_FORMULA_BUILDERS[lane](8, c);
    Object.entries(built).forEach(([col, formula]) => {
      const deps = new Set();
      columnDeps(parseFormula(formula), tab, deps);
      let n = Number(col) + 1;
      let letters = '';
      while (n > 0) { letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters; n = Math.floor((n - 1) / 26); }
      graph.set(`${tab}!${letters}`, deps);
    });
  });

  // The two derived cells on the Settings tab, which every transfer column reads.
  const qualify = G.laneWorkColumns(c, 'TAC_TO_AWD').QUALIFY;
  let n = qualify + 1;
  let qCol = '';
  while (n > 0) { qCol = String.fromCharCode(65 + ((n - 1) % 26)) + qCol; n = Math.floor((n - 1) / 26); }
  graph.set(`@${G.SETTINGS_NAMES.RUN_TAC_AWD_QUALIFYING}`,
    new Set([`${c.TABS.TAC_TO_AWD}!${qCol}`]));
  graph.set(`@${G.SETTINGS_NAMES.RUN_TAC_AWD_VERDICT}`,
    new Set([`@${G.SETTINGS_NAMES.RUN_TAC_AWD_QUALIFYING}`,
      `@${G.SETTINGS_NAMES.PALLET_MIN}`]));

  const state = new Map();
  const trail = [];
  function walk(node) {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') {
      return trail.slice(trail.indexOf(node)).concat(node).join(' → ');
    }
    state.set(node, 'open');
    trail.push(node);
    for (const dep of graph.get(node) || []) {
      const cycle = walk(dep);
      if (cycle) return cycle;
    }
    trail.pop();
    state.set(node, 'done');
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = walk(node);
    assert.equal(cycle, null, `circular dependency: ${cycle}`);
  }
});

test('cross-lane lookups touch one column, not a slab', () => {
  const c = cfg();
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const built = G.LANE_FORMULA_BUILDERS[lane](8, c);
    Object.entries(built).forEach(([col, formula]) => {
      assert.ok(!/VLOOKUP\(\s*\$?[A-Z]+\d+\s*,\s*'/.test(formula),
        `${lane} col ${col} still uses a cross-sheet VLOOKUP block:\n${formula}`);
    });
  });
});

test('a lane stops at its last SKU, not at a stray cell far below', () => {
  const c = cfg();
  const first = c.LAYOUT.LANE_FIRST_DATA_ROW;
  const nameCol = c.COLS.TAC_TO_AWD.NAME;

  // 491 SKUs, then nothing until a leftover value at what would be row 5741.
  const grid = [];
  const put = (r, col, v) => {
    while (grid.length < r) grid.push([]);
    grid[r - 1][col] = v;
  };
  for (let i = 0; i < 491; i++) put(first + i, nameCol, `SKU-${i}`);
  put(5741, nameCol, 'stray');

  const sheet = {
    getLastRow: () => 5741,
    getRange: (row, col, rows) => ({
      getValues: () => {
        const out = [];
        for (let r = row; r < row + rows; r++) {
          out.push([(grid[r - 1] || [])[col - 1] ?? '']);
        }
        return out;
      },
    }),
  };

  assert.equal(G.laneRowCount(sheet, 'TAC_TO_AWD', c), 491,
    'the stray value at row 5741 must not stretch the lane to meet it');
});

// ------------------------------------------------ named ranges are not deleted

test('the Settings tab moves a named range, never deletes it', () => {
  // Deleting a named range rewrites every formula that referenced it to the
  // literal text #REF!, and re-creating the name cannot undo that. Doing it on
  // every run shredded the lane formulas the previous run had written.
  const c = cfg();
  const plan = G.layoutSettings(c);
  const removed = [];
  const moved = [];
  const created = [];
  const sheetId = 7;
  const mkRange = (a1) => ({
    getA1Notation: () => a1,
    getSheet: () => ({ getSheetId: () => sheetId }),
  });
  const sh = {
    getSheetId: () => sheetId,
    getRange: (row, col, nr, nc) => mkRange(`R${row}C${col}:${nr || 1}x${nc || 1}`),
  };
  const existing = plan.dials.map((d) => ({
    getName: () => d.name,
    getRange: () => mkRange('somewhere-else'),
    setRange: () => moved.push(d.name),
    remove: () => removed.push(d.name),
  }));
  const ss = {
    getNamedRanges: () => existing,
    setNamedRange: (n) => created.push(n),
  };

  G.nameSettingsRanges(ss, sh, plan);

  assert.deepEqual(removed, [],
    'a named range that formulas depend on must never be removed');
  assert.ok(moved.length > 0, 'existing names are re-pointed in place');
  assert.ok(created.length > 0, 'names that do not exist yet are created');
});

// ------------------------------------------------------- the 101-4001 floor

const FLOOR_SKU = '101-4001';

test('AWD > FBA fills a unit floor its own passes would have ignored', () => {
  const c = cfg();
  // 20 units at FBA against a 100-unit floor. Days of cover say 20 against a
  // baseline of 60, so pass 3 asks for 40 — the floor asks for 80.
  const rows = harmonise('AWD_TO_FBA', [awdFbaRow({
    sku: FLOOR_SKU, rate: 1, trueRate30: 1, caseQty: 1,
    amzFulfillable: 20, amzReserved: 0, amzInbound: 0, awdAvailableUnits: 500,
  })]);

  const rules = G.planAwdToFba(rows, c, {}).map((d) => Math.max(0, d.cases));
  const wb = buildWorkbook(gs, c, { awdToFba: rows });
  const sheet = sheetCases(wb, c, 'AWD_TO_FBA', rows);

  assert.deepEqual(sheet, [80], 'the sheet tops it up to the floor');
  assert.deepEqual(rules, [80], 'and so does the rule engine');

  const W = G.laneWorkColumns(c, 'AWD_TO_FBA');
  assert.equal(cell(wb, c, 'AWD_TO_FBA', W.NEEDED, 8), 80,
    'and the target column reads as the floor, not as days of cover');
});

test('Tactical > FBA fills what AWD could not, and nothing more', () => {
  const c = cfg();
  const base = {
    sku: FLOOR_SKU, rate: 1, trueRate30: 1, caseQty: 1,
    amzFulfillable: 20, amzReserved: 0, amzInbound: 0,
  };

  // AWD holds 30 units, so it can only cover 30 of the 80 shortfall.
  const awd = harmonise('AWD_TO_FBA', [awdFbaRow({ ...base, awdAvailableUnits: 30 })]);
  const tac = harmonise('TAC_TO_FBA', [tacFbaRow({
    ...base, awdAvailableUnits: 30, tacAvailableUnits: 1000, minUnits: 0,
  })]);

  const awdDec = G.planAwdToFba(awd, c, {});
  const awdBySku = {};
  awd.forEach((r, i) => {
    awdBySku[G.normSku(r.sku)] = {
      cases: awdDec[i].cases,
      units: Math.max(0, awdDec[i].cases) * r.caseQty,
      cappedByAwdStock: !!awdDec[i].cappedByAwdStock,
      shortfallCases: awdDec[i].shortfallCases || 0,
      awdAvailableUnits: r.awdAvailableUnits,
    };
  });
  const rules = G.planTacToFba(tac, c, {}, awdBySku, {}).map((d) => Math.max(0, d.cases));

  const wb = buildWorkbook(gs, c, { awdToFba: awd, tacToFba: tac });
  assert.deepEqual(sheetCases(wb, c, 'AWD_TO_FBA', awd), [30], 'AWD sends all it has');
  assert.deepEqual(sheetCases(wb, c, 'TAC_TO_FBA', tac), [50],
    'Tactical covers the remaining 50 units of the floor');
  assert.deepEqual(rules, [50], 'and the rule engine agrees');
});

test('Tactical > FBA stays out when AWD is filling the floor by itself', () => {
  const c = cfg();
  const base = {
    sku: FLOOR_SKU, rate: 1, trueRate30: 1, caseQty: 1,
    amzFulfillable: 20, amzReserved: 0, amzInbound: 0,
  };
  const awd = harmonise('AWD_TO_FBA', [awdFbaRow({ ...base, awdAvailableUnits: 500 })]);
  const tac = harmonise('TAC_TO_FBA', [tacFbaRow({
    ...base, awdAvailableUnits: 500, tacAvailableUnits: 1000, minUnits: 0,
  })]);

  const wb = buildWorkbook(gs, c, { awdToFba: awd, tacToFba: tac });
  assert.deepEqual(sheetCases(wb, c, 'AWD_TO_FBA', awd), [80]);
  assert.deepEqual(sheetCases(wb, c, 'TAC_TO_FBA', tac), [0],
    'the floor is met once between the two lanes, not twice');
});

test('a unit floor is not stopped by the residual or inbound gates', () => {
  const c = cfg();
  // AWD holds nothing and has replenishment landing inside 14 days, which
  // normally shuts this lane. The floor is not a replenishment judgement.
  const tac = harmonise('TAC_TO_FBA', [tacFbaRow({
    sku: FLOOR_SKU, rate: 1, trueRate30: 1, caseQty: 1,
    amzFulfillable: 20, amzReserved: 0, amzInbound: 0,
    awdAvailableUnits: 0, tacAvailableUnits: 1000, minUnits: 0,
  })]);
  const tacAwd = harmonise('TAC_TO_AWD', [tacAwdRow({
    sku: FLOOR_SKU, rate: 1, caseQty: 1, awdQty: 0, awdInbound14: 400,
    tacAvailableUnits: 1000, minUnits: 0, fbaDoi: 20,
  })]);

  const wb = buildWorkbook(gs, c, { tacToFba: tac, tacToAwd: tacAwd });
  assert.deepEqual(sheetCases(wb, c, 'TAC_TO_FBA', tac), [80]);

  const rules = G.planTacToFba(tac, c, {}, {}, { [FLOOR_SKU]: 400 })
    .map((d) => Math.max(0, d.cases));
  assert.deepEqual(rules, [80], 'the rule engine walks past the same gates');
});

// ------------------------------------------- counting a lane's real data rows

/** A sheet stub holding one column of values, plus a stray far below. */
function stubSheet(col0, first, count, strayAt) {
  const grid = [];
  const put = (r, c, v) => {
    while (grid.length < r) grid.push([]);
    grid[r - 1][c] = v;
  };
  for (let i = 0; i < count; i++) put(first + i, col0, `SKU-${i}`);
  if (strayAt) put(strayAt, col0, 'stray');
  const lastRow = strayAt || (first + count - 1);
  return {
    getLastRow: () => lastRow,
    getRange: (row, col, rows) => ({
      getValues: () => {
        const out = [];
        for (let r = row; r < row + rows; r++) out.push([(grid[r - 1] || [])[col - 1] ?? '']);
        return out;
      },
    }),
  };
}

test('countDataRows stops at the last SKU, on any tab', () => {
  const c = cfg();
  const first = c.LAYOUT.LANE_FIRST_DATA_ROW;

  // The IMS Tactical > AWD tab: 491 SKUs, stray formulas down to row 5741.
  const ims = stubSheet(1, first, 491, 5741);
  assert.equal(G.countDataRows(ims, 1, first), 491,
    'the IMS tab reports 5741 as its last row; it holds 491 SKUs');

  // And the planner's own lane, keyed on its own SKU column.
  const lane = stubSheet(c.COLS.TAC_TO_AWD.NAME, first, 491, 5741);
  assert.equal(G.laneRowCount(lane, 'TAC_TO_AWD', c), 491);

  assert.equal(G.countDataRows(stubSheet(1, first, 0, 0), 1, first), 0,
    'an empty tab counts as none');
});

test('a column that would not take the formula is caught, not waved through', () => {
  const c = cfg();
  const want = '=IF($C8="","",IF(N($F8)<=0,0,MAX(0,Dss_BaselineDoi)))';
  const byColumn = { 15: [[want]] };
  const at = (formula) => ({ getRange: () => ({ getFormula: () => formula }) });

  assert.deepEqual(G.unwrittenColumns(at(''), byColumn, 8), ['15'],
    'a blank transfer column is a failure, not a plan');

  // The 09-09 failure: our write dropped, the template's own formula left in
  // place. It is a formula, and it has no #REF!, and it is still wrong.
  assert.deepEqual(G.unwrittenColumns(at('=ROUNDUP((100-O8)*F8/Q8,0)'), byColumn, 8),
    ['15'], "the template's own formula must not pass for ours");

  assert.deepEqual(G.unwrittenColumns(at('=IF($C8="","",IF(N($F8)<=0,0,#REF!)))'),
    byColumn, 8), ['15'], 'nor may one carrying #REF!');

  assert.deepEqual(G.unwrittenColumns(at(want), byColumn, 8), [],
    'the formula we asked for passes');
  assert.deepEqual(
    G.unwrittenColumns(at('=IF($C8="", "", IF(N($F8)<=0, 0, MAX(0, Dss_BaselineDoi)))'),
      byColumn, 8), [],
    "and so does the same formula after Sheets has reformatted it");
});

test('adjacent columns are written in one call, not one each', () => {
  const written = [];
  const sheet = {
    getRange: (r, cc, nr, nc) => ({
      setFormulas: () => written.push({ col: cc, width: nc, rows: nr }),
    }),
  };
  const byColumn = { 8: [['=A']], 9: [['=B']], 13: [['=C']], 14: [['=D']], 15: [['=E']] };
  G.writeColumnBlocks(sheet, byColumn, 8, 1);

  assert.deepEqual(written, [
    { col: 9, width: 2, rows: 1 },
    { col: 14, width: 3, rows: 1 },
  ], 'two runs of adjacent columns, two calls');
});

// -------------------------------------------------------- the output tabs

/** A workbook stub that records every formula written to every tab. */
function mockPlanner(name) {
  const written = new Map();       // tab -> [{row, col, formula}]
  const tab = (t) => ({
    getMaxRows: () => 1000,
    getMaxColumns: () => 30,
    getRange: (r, c) => ({
      setFormula: (f) => {
        if (!written.has(t)) written.set(t, []);
        written.get(t).push({ row: r, col: c, formula: f });
      },
      clearContent() { return this; },
      setBackground() { return this; },
    }),
    getName: () => t,
  });
  return {
    written,
    getName: () => name,
    getSheets: () => [],
    _tab: tab,
  };
}

function runOutputs(c) {
  const planner = mockPlanner('09-10-26');
  const tabs = new Map();
  // sheetByName walks getSheets(); hand it a sheet for every configured tab.
  const names = Object.values(c.TABS);
  const sheets = names.map((n) => {
    const s = planner._tab(n);
    tabs.set(n, s);
    return s;
  });
  planner.getSheets = () => sheets;
  const res = G.writeOutputFormulas(planner, c,
    { TAC_TO_AWD: 491, AWD_TO_FBA: 491, TAC_TO_FBA: 491 });
  return { planner, res };
}

test('the pick lists and CSV tabs are written as formulas', () => {
  const c = cfg();
  const { planner, res } = runOutputs(c);

  const expected = {
    [c.TABS.SUMMARY_TAC_AWD]: 6,
    [c.TABS.SUMMARY_AWD_FBA]: 5,
    [c.TABS.SUMMARY_TAC_FBA]: 5,
    [c.TABS.CSV_TAC_AWD]: 4,     // externalid and FBA_iD stay blank
    [c.TABS.CSV_TAC_FBA]: 4,
    [c.TABS.CSV_TO_TACTICAL]: 4,
  };
  for (const [tabName, count] of Object.entries(expected)) {
    const got = planner.written.get(tabName) || [];
    assert.equal(got.length, count, `${tabName} should get ${count} formulas`);
    got.forEach((w) => assert.ok(w.formula.startsWith('='),
      `${tabName} col ${w.col} is not a formula: ${w.formula}`));
  }
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
});

test('every generated formula parses, on the lanes and the output tabs', () => {
  const c = cfg();

  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const built = G.LANE_FORMULA_BUILDERS[lane](8, c);
    Object.entries(built).forEach(([col, f]) => {
      assert.doesNotThrow(() => parseFormula(f),
        `${lane} col ${col} does not parse:\n${f}`);
    });
  });

  const { planner } = runOutputs(c);
  for (const [tabName, rows] of planner.written) {
    rows.forEach((w) => {
      assert.doesNotThrow(() => parseFormula(w.formula),
        `${tabName} col ${w.col} does not parse:\n${w.formula}`);
    });
  }
});

test('no generated formula uses a locale-dependent array literal', () => {
  const c = cfg();
  const check = (label, f) => {
    assert.ok(!/[{}]/.test(f),
      `${label} uses {} — the array separator differs by locale:\n${f}`);
  };
  ['TAC_TO_AWD', 'AWD_TO_FBA', 'TAC_TO_FBA'].forEach((lane) => {
    const built = G.LANE_FORMULA_BUILDERS[lane](8, c);
    Object.entries(built).forEach(([col, f]) => check(`${lane} ${col}`, f));
  });
  const { planner } = runOutputs(c);
  for (const [tabName, rows] of planner.written) {
    rows.forEach((w) => check(`${tabName} ${w.col}`, w.formula));
  }
});

test('the pick lists read the transfer column, so an edit reaches them', () => {
  const c = cfg();
  const { planner } = runOutputs(c);

  const casesCol = (lane) => colLetterOf(c.COLS[lane].CASES_OUT);
  const awdFba = planner.written.get(c.TABS.SUMMARY_AWD_FBA)[0].formula;
  assert.ok(awdFba.includes(`$${casesCol('AWD_TO_FBA')}$8`),
    `the AWD > FBA pick list must filter on its transfer column:\n${awdFba}`);

  const csv = planner.written.get(c.TABS.CSV_TAC_AWD);
  const sku = csv.find((w) => w.col === 4).formula;
  assert.ok(sku.includes(`$${casesCol('TAC_TO_AWD')}$8`),
    `the Tactical > AWD CSV must filter on its transfer column:\n${sku}`);
});

function colLetterOf(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ------------------------------------------ filters, the silent write-swallower

test('a filter is removed and hidden rows shown before anything is written', () => {
  const events = [];
  const filter = {
    getRange: () => ({ getA1Notation: () => 'A7:Z498' }),
    remove: () => events.push('filter removed'),
  };
  const sheet = {
    getFilter: () => filter,
    getMaxRows: () => 1000,
    showRows: (from, n) => events.push(`rows shown ${from}..${from + n - 1}`),
  };

  assert.equal(G.unhideForWriting(sheet), 'filter over A7:Z498');
  assert.deepEqual(events, ['filter removed', 'rows shown 1..1000'],
    'Apps Script will not write to a row a filter has hidden');
});

test('a sheet with nothing in the way reports nothing removed', () => {
  const shown = [];
  const sheet = {
    getFilter: () => null,
    getMaxRows: () => 500,
    showRows: (from, n) => shown.push([from, n]),
  };
  assert.equal(G.unhideForWriting(sheet), null);
  assert.deepEqual(shown, [[1, 500]], 'rows are still unhidden, cheaply');
});

test('an older runtime without getFilter still gets its rows shown', () => {
  const shown = [];
  const sheet = {
    getMaxRows: () => 20,
    showRows: (from, n) => shown.push([from, n]),
  };
  assert.equal(G.unhideForWriting(sheet), null, 'no getFilter() is not an error');
  assert.deepEqual(shown, [[1, 20]]);
});
