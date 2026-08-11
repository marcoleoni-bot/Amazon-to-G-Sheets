import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { loadAppsScript, awdFbaRow, tacAwdRow, tacFbaRow, GS_DIR } from './helpers/load-gs.js';

/**
 * The rule layer, exercised through the same .gs files the editor runs.
 *
 * The fixtures marked "08-10-26" are real rows lifted out of that planner,
 * rates and all. Where Marco's typed number is quoted, it is quoted exactly —
 * including the three places the spec and his sheet disagree, which are
 * asserted as differences rather than smoothed over. That is the whole point
 * of the back-test: a difference is either a bug or an unwritten rule, and
 * pretending it isn't there loses the signal.
 */
const { context: G, files } = loadAppsScript();
const cfg = () => G.config();

test('every .gs file parses and defines its entry points', () => {
  assert.ok(files.length >= 9, `expected the full module set, saw ${files}`);
  for (const fn of ['config', 'dssFor', 'num', 'roundUp', 'dssLadder',
    'planAwdToFba', 'planTacToAwd', 'planTacToFba', 'applyPalletFill',
    'allocateTactical', 'planUsTransferOrders', 'writePlan', 'readPlanningInput',
    'buildPlan', 'backtest']) {
    assert.equal(typeof G[fn], 'function', `${fn} is not defined`);
  }
});

test('the one-file bundle is in step with the modules', () => {
  // The bundle exists so installing by hand is one paste. That only helps if
  // it is the same code — a stale bundle is worse than no bundle.
  const bundle = readFileSync(join(GS_DIR, 'dist', 'Code.gs'), 'utf8');
  for (const file of files) {
    const src = readFileSync(join(GS_DIR, file), 'utf8').trimEnd();
    assert.ok(bundle.includes(src),
      `${file} has changed since the bundle was built — run: npm run bundle`);
  }
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'Code.gs' }),
    'the bundle must parse as one script');
});

// --------------------------------------------------------------------- Lib

test('sheet errors read as a default, never as NaN', () => {
  for (const bad of ['#N/A', '#DIV/0!', 'No Rate', '', null, undefined]) {
    assert.equal(G.num(bad), 0, `${bad} should fall back to 0`);
  }
  assert.equal(G.num('1,481'), 1481, 'thousands separators are still numbers');
  assert.equal(G.num(42.5), 42.5);
  assert.equal(G.num('#N/A', null), null);
});

test('roundUp rounds away from zero, as ROUNDUP does', () => {
  assert.equal(G.roundUp(7.0001), 8);
  assert.equal(G.roundUp(7), 7);
  assert.equal(G.roundUp(-1.2), -2);
});

test('the DSS ladder follows the sheet IFS in order', () => {
  // source + dest under target -> everything available
  assert.equal(G.dssLadder(60, 10, 20, 7, 10, 20), 7);
  // destination already past target -> nothing
  assert.equal(G.dssLadder(60, 100, 61, 7, 10, 20), 0);
  // need is under one case -> one case, because cases cannot be split
  assert.equal(G.dssLadder(60, 100, 59, 7, 10, 500), 1);
  // ordinary top-up
  assert.equal(G.dssLadder(60, 100, 50, 99, 10, 20), G.roundUp(10 * 10 / 20));
});

// -------------------------------------------------------------- AWD > FBA

test('pass 1 fires only when stock is reserved AND cover is thin', () => {
  const c = cfg();
  // 08-10-26 401-1037-ALS: reserved 22 of 34 fulfillable, 35.5 days of cover.
  const row = awdFbaRow({
    sku: '401-1037-ALS', rate: 0.9585714286, awdAvailableUnits: 40,
    availableCases: 2, awdDoi: 47.16, amzFulfillable: 34, amzReserved: 22,
    amzTotal: 56, amzDoi: 58.42026826, caseQty: 20, lifecycle: 'Discontinued',
  });
  const [d] = G.planAwdToFba([row], c, {});
  assert.equal(d.pass, 'PASS_1');
  assert.equal(d.cases, 1, 'Marco typed 1 on 08-10-26');
  assert.match(d.rule, /reserved-blocked/);
});

test('a healthy reserved ratio keeps a SKU out of pass 1', () => {
  // 101-2047: only 19% reserved, so it belongs to pass 2 on its B2B flag.
  const row = awdFbaRow({
    sku: '101-2047', b2b: true, critical: true, rate: 17.8447619,
    awdAvailableUnits: 2868, availableCases: 239, awdDoi: 172.15,
    amzFulfillable: 1325, amzReserved: 249, amzInbound: 24, amzTotal: 1598,
    amzDoi: 89.55008806, caseQty: 12,
  });
  const [d] = G.planAwdToFba([row], cfg(), {});
  assert.equal(d.pass, 'PASS_2');
  assert.equal(d.cases, 16, 'Marco typed 16 on 08-10-26');
});

test('pass 1 cap B sends a single case up to 110 DOI and nothing above it', () => {
  const c = cfg();
  const base = {
    rate: 1, amzFulfillable: 10, amzReserved: 40, availableCases: 50,
    awdAvailableUnits: 1000, caseQty: 20,
  };
  // 95 + 20 = 115 units at rate 1 -> 115 DOI, past the 110 ceiling.
  const over = G.planAwdToFba([awdFbaRow({ ...base, amzTotal: 95 })], c, {})[0];
  assert.equal(over.cases, 0);
  assert.match(over.rule, /would reach 115 DOI \(>110\)/);

  // 85 + 20 = 105 DOI, inside it, so the indivisible case goes.
  const under = G.planAwdToFba([awdFbaRow({ ...base, amzTotal: 85 })], c, {})[0];
  assert.equal(under.cases, 1);
  assert.match(under.notes.join(' '), /within 110/);
});

test('pass 2 holds B2B and Critical at 100 DOI, and stops at the shelf', () => {
  // 101-2110: wants 97 cases, AWD has 6.
  const row = awdFbaRow({
    sku: '101-2110', b2b: true, rate: 22.7147619, awdAvailableUnits: 72,
    availableCases: 6, awdDoi: 3.07, amzFulfillable: 926, amzReserved: 421,
    amzInbound: -228, amzTotal: 1119, amzDoi: 49.26311817, caseQty: 12,
  });
  const [d] = G.planAwdToFba([row], cfg(), {});
  assert.equal(d.pass, 'PASS_2');
  assert.equal(d.cases, 6, 'Marco typed 6 on 08-10-26');
  assert.equal(d.cappedByAwdStock, true);
  assert.ok(d.shortfallCases > 0);
  assert.ok(d.flags.includes('NEEDS_REVIEW'));
  assert.match(G.reasonText(d, 12), /capped by AWD stock/);
});

test('a pass 2 trigger stops topping up SKUs that are still comfortable', () => {
  // 07-20-26 101-2104: Critical, sitting on 88 DOI with 29 cases in AWD.
  // The spec has no trigger, so pass 2 pushes it to 100 every run — 8 cases.
  // Nothing shipped for it that week.
  const row = awdFbaRow({
    sku: '101-2104', b2b: true, critical: true, rate: 10, awdAvailableUnits: 464,
    availableCases: 29, awdDoi: 46, amzFulfillable: 880, amzTotal: 880,
    amzDoi: 88, caseQty: 16,
  });
  assert.equal(G.planAwdToFba([row], cfg(), {})[0].cases, 8, 'spec default');

  const gated = cfg();
  gated.RULES.PASS2_TRIGGER_DOI = 60;
  const [d] = G.planAwdToFba([row], gated, {});
  assert.equal(d.cases, 0);
  assert.equal(d.pass, 'PASS_3', 'it falls through to the baseline rule');
});

test('a priority SKU below the trigger is still topped to 100', () => {
  const gated = cfg();
  gated.RULES.PASS2_TRIGGER_DOI = 60;
  const row = awdFbaRow({ b2b: true, rate: 10, awdAvailableUnits: 1000,
    availableCases: 50, awdDoi: 100, amzFulfillable: 500, amzTotal: 500,
    amzDoi: 50, caseQty: 20 });
  const [d] = G.planAwdToFba([row], gated, {});
  assert.equal(d.pass, 'PASS_2');
  assert.equal(d.cases, 25); // (100-50)*10/20
});

test('a priority SKU already past target is left alone', () => {
  // 101-2092-B sits at 106.6 DOI. Marco typed 0.
  const row = awdFbaRow({
    sku: '101-2092-B', critical: true, rate: 14.92333333,
    awdAvailableUnits: 1752, availableCases: 73, awdDoi: 114.2,
    amzFulfillable: 1481, amzReserved: 110, amzTotal: 1591,
    amzDoi: 106.6115702, caseQty: 24,
  });
  const [d] = G.planAwdToFba([row], cfg(), {});
  assert.equal(d.cases, 0);
  assert.match(G.reasonText(d, 24), /^0 — already 107 DOI/);
});

test('pass 3 proposes the number but asks for a look above 7 cases', () => {
  const row = awdFbaRow({ rate: 10, amzTotal: 100, amzDoi: 10, awdDoi: 100,
    caseQty: 20, availableCases: 50, awdAvailableUnits: 1000 });
  const [d] = G.planAwdToFba([row], cfg(), {});
  assert.equal(d.pass, 'PASS_3');
  assert.equal(d.cases, 25); // (60-10)*10/20
  assert.ok(d.flags.includes('NEEDS_REVIEW'));
  assert.match(G.reasonText(d, 20), /baseline 60 DOI.*over 7 cases.*⚠ review/);
});

test('a SKU claimed by an earlier pass is not reconsidered', () => {
  // Reserved-blocked *and* B2B: pass 1 owns it.
  const row = awdFbaRow({
    b2b: true, rate: 1, amzFulfillable: 10, amzReserved: 40, amzTotal: 50,
    amzDoi: 50, caseQty: 5, availableCases: 50, awdAvailableUnits: 1000,
  });
  const [d] = G.planAwdToFba([row], cfg(), {});
  assert.equal(d.pass, 'PASS_1');
});

test('repeated rows for one SKU cannot spend the same AWD stock twice', () => {
  const mk = () => awdFbaRow({
    sku: 'DUP-1', rate: 10, amzTotal: 0, amzDoi: 0, awdDoi: 100,
    caseQty: 20, availableCases: 5, awdAvailableUnits: 100,
  });
  const out = G.planAwdToFba([mk(), mk()], cfg(), {});
  assert.equal(out[0].cases, 5);
  assert.equal(out[1].cases, 0, 'the second row finds the shelf empty');
  assert.match(out[1].notes.join(' '), /no AWD stock/);
});

test('a SKU with no rate is reported, not divided by zero', () => {
  const [d] = G.planAwdToFba([awdFbaRow({ rate: 0 })], cfg(), {});
  assert.equal(d.cases, 0);
  assert.match(d.rule, /no order_plan_rate/);
});

test('LTF neither zeroes nor sends — it surfaces the comment', () => {
  const row = awdFbaRow({ sku: '401-1037-ALS', rate: 10, amzTotal: 100,
    amzDoi: 10, caseQty: 20, availableCases: 50 });
  const ltf = { '401-1037-ALS': { comment: 'It’s selling well.' } };
  const [d] = G.planAwdToFba([row], cfg(), ltf);
  assert.ok(d.cases > 0, 'the quantity still stands');
  assert.ok(d.flags.includes('LTF_FLAG'));
  assert.equal(d.ltfComment, 'It’s selling well.');
  assert.match(G.reasonText(d, 20), /LTF: "It’s selling well\."\. Review/);
});

// ------------------------------------------------------------ Tactical > AWD

test('discontinued SKUs never move to AWD', () => {
  const row = tacAwdRow({ lifecycle: 'Discontinued', awdDoi: 0, wrDoi: 1 });
  const [d] = G.planTacToAwd([row], cfg(), {});
  assert.equal(d.cases, 0);
  assert.equal(d.rule, 'discontinued');
});

test('Tactical > AWD tops AWD up to the baseline', () => {
  // 08-10-26 101-2106 at DSS 60.
  const row = tacAwdRow({
    sku: '101-2106', rate: 3.356666667, tacAvailableUnits: 180,
    availableCases: 10, wrDoi: 53.58, awdQty: 126, awdDoi: 37.53723932,
    caseQty: 18, fbaDoi: 68.2224429,
  });
  const [d] = G.planTacToAwd([row], cfg(), {});
  assert.equal(d.cases, 5, 'the spec\'s 60 DOI target; Marco typed 10');
});

test('a comfortable SKU does not drag a pallet of filler along with it', () => {
  // Marco's own case: one SKU on 40 days of AWD cover with FBA healthy behind
  // it wants 5 cases. Filling to 25 would mean 20 cases of SKUs that needed
  // nothing — more freight and more stock at AWD than doing nothing.
  const c = cfg();
  const rows = [tacAwdRow({ sku: 'COMFY', awdDoi: 40, awdQty: 400, fbaDoi: 90,
    wrDoi: 100, caseQty: 20, availableCases: 40, tacAvailableUnits: 800 })];
  const dec = G.planTacToAwd(rows, c, {});
  assert.ok(dec[0].cases > 0, 'the ladder still wants stock');

  const verdict = G.decideTacToAwdRun(rows, dec, c);
  assert.equal(verdict.raise, false);
  assert.match(verdict.why, /nothing urgent/);
  assert.match(verdict.why, /COMFY at 40 DOI/);
  assert.equal(dec[0].cases, 0, 'the lane is zeroed, not left with numbers');
  assert.match(G.reasonText(dec[0], 20), /held for a later run/);
  assert.match(G.reasonText(dec[0], 20), /not urgent/);
});

test('a thin SKU that FBA cannot cover justifies the run', () => {
  const c = cfg();
  const rows = [tacAwdRow({ sku: 'THIN', awdDoi: 20, awdQty: 200, fbaDoi: 25,
    wrDoi: 100, caseQty: 20, availableCases: 40, tacAvailableUnits: 800 })];
  const dec = G.planTacToAwd(rows, c, {});
  const verdict = G.decideTacToAwdRun(rows, dec, c);
  assert.equal(verdict.raise, true);
  assert.match(verdict.why, /THIN \(20 DOI\)/);
  assert.ok(dec[0].cases > 0);
});

test('an empty AWD shelf is not urgent when FBA is sitting on years of cover', () => {
  // 101-2102, real: no AWD stock at all — 0 days of cover, which looks like
  // the most urgent row in the book — while FBA holds 599 days and it sells a
  // sixth of a unit a day. Reading AWD alone makes this SKU justify a pallet
  // every week.
  const c = cfg();
  const rows = [tacAwdRow({ sku: '101-2102', rate: 0.16, awdDoi: 0, awdQty: 0,
    fbaDoi: 599.1, wrDoi: 1875, caseQty: 50, availableCases: 6,
    tacAvailableUnits: 300 })];
  const dec = G.planTacToAwd(rows, c, {});
  assert.ok(dec[0].cases > 0, 'the ladder still wants to top AWD up');
  assert.equal(G.decideTacToAwdRun(rows, dec, c).raise, false,
    'but it is the quietest SKU in the catalogue, not an emergency');
});

test('an empty AWD shelf IS urgent once FBA is thin too', () => {
  const c = cfg();
  const rows = [tacAwdRow({ sku: 'EMPTY', awdDoi: 0, awdQty: 0, fbaDoi: 25,
    wrDoi: 100, caseQty: 20, availableCases: 40, tacAvailableUnits: 800 })];
  const dec = G.planTacToAwd(rows, c, {});
  assert.equal(G.decideTacToAwdRun(rows, dec, c).raise, true);
});

test('a held run is not padded to a pallet', () => {
  const c = cfg();
  const rows = [
    tacAwdRow({ sku: 'COMFY', awdDoi: 40, awdQty: 400, fbaDoi: 90, wrDoi: 100,
      caseQty: 20, availableCases: 40, tacAvailableUnits: 800 }),
    tacAwdRow({ sku: 'SPARE', awdDoi: 70, awdQty: 700, fbaDoi: 90, wrDoi: 100,
      caseQty: 20, availableCases: 40, tacAvailableUnits: 800 }),
  ];
  const input = { tacToAwd: rows, awdToFba: [], tacToFba: [], ltfIndex: {} };
  const plan = G.planUsTransferOrders(input, c);

  assert.equal(plan.totals.tacToAwdCases, 0, 'no cases at all, filler included');
  assert.equal(plan.pallet.filledCases, 0);
  assert.equal(plan.verdicts.tacToAwd.raise, false);
  assert.match(plan.verdicts.tacToAwd.why, /nothing urgent/);
});

test('each lane says plainly whether to raise the order', () => {
  const c = cfg();
  const input = {
    tacToAwd: [tacAwdRow({ sku: 'A', awdDoi: 5, fbaDoi: 10, wrDoi: 100,
      caseQty: 20, availableCases: 40, tacAvailableUnits: 800 })],
    awdToFba: [awdFbaRow({ sku: 'A', rate: 10, amzTotal: 100, amzDoi: 10,
      awdDoi: 100, caseQty: 20, availableCases: 50, awdAvailableUnits: 1000 })],
    tacToFba: [],
    ltfIndex: {},
  };
  const v = G.planUsTransferOrders(input, c).verdicts;

  assert.equal(v.tacToAwd.raise, true);
  assert.equal(v.awdToFba.raise, true);
  assert.match(v.awdToFba.why, /1 SKU, 25 cases/);
  assert.equal(v.tacToFba.raise, false);
  assert.match(v.tacToFba.why, /AWD is covering every shortfall/);
});

test('the pallet minimum tops a short run up from SKUs nearest to needing it', () => {
  const c = cfg();
  // 5 cases of genuine demand, so the run is short of the 25-case pallet.
  const demand = tacAwdRow({ sku: 'NEEDS', awdDoi: 50, awdQty: 500, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 });
  // Two candidates already above target; the lower DOI is served first.
  const near = tacAwdRow({ sku: 'NEAR', awdDoi: 65, awdQty: 650, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 });
  const far = tacAwdRow({ sku: 'FAR', awdDoi: 80, awdQty: 800, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 });

  const rows = [demand, near, far];
  const dec = G.planTacToAwd(rows, c, {});
  assert.ok(dec[0].cases > 0 && dec[1].cases === 0 && dec[2].cases === 0);

  const headroom = { NEEDS: 800, NEAR: 800, FAR: 800 };
  const before = dec[0].cases;
  const res = G.applyPalletFill(rows, dec, c, headroom, {});

  assert.equal(dec[0].cases, before, 'demand rows are untouched by the fill');
  assert.equal(dec[1].pass, 'PALLET_FILL');
  assert.ok(dec[1].cases >= dec[2].cases, 'the nearer SKU is filled first');
  assert.match(G.reasonText(dec[1], 20), /pallet fill, pulled forward/);

  // Two SKUs at 2 cases each is all this pool can give, so the run stays short
  // rather than pretending the pallet is full.
  assert.equal(res.filledCases, 4);
  assert.equal(res.shortfall, c.RULES.PALLET_MIN_CASES - before - 4);
});

test('a deep enough filler pool reaches the pallet minimum exactly', () => {
  const c = cfg();
  const rows = [tacAwdRow({ sku: 'NEEDS', awdDoi: 50, awdQty: 500, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 })];
  const headroom = { NEEDS: 800 };
  // Twelve candidates above target, none of which the ladder wants to send.
  for (let i = 0; i < 12; i++) {
    rows.push(tacAwdRow({ sku: `FILL${i}`, awdDoi: 62 + i, awdQty: 620 + i * 10,
      wrDoi: 100, caseQty: 20, availableCases: 40, tacAvailableUnits: 800 }));
    headroom[`FILL${i}`] = 800;
  }

  const dec = G.planTacToAwd(rows, c, {});
  const before = dec[0].cases;
  const res = G.applyPalletFill(rows, dec, c, headroom, {});

  assert.equal(res.shortfall, 0);
  assert.equal(before + res.filledCases, c.RULES.PALLET_MIN_CASES);
  const total = dec.reduce((s, d) => s + d.cases, 0);
  assert.equal(total, c.RULES.PALLET_MIN_CASES, 'the run ships a full pallet');
  assert.match(G.palletStatus(res), /topped up to 25 cases/);
});

test('no demand means no pallet, rather than a pallet of pure filler', () => {
  const c = cfg();
  const rows = [tacAwdRow({ sku: 'FULL', awdDoi: 90, wrDoi: 100 })];
  const dec = G.planTacToAwd(rows, c, {});
  assert.equal(dec[0].cases, 0);
  const res = G.applyPalletFill(rows, dec, c, { FULL: 800 }, {});
  assert.equal(res.skipped, true);
  assert.equal(res.filledCases, 0);
});

test('an exhausted filler pool is reported, not shipped short in silence', () => {
  const c = cfg();
  const rows = [
    tacAwdRow({ sku: 'NEEDS', awdDoi: 55, awdQty: 550, wrDoi: 100,
      caseQty: 20, availableCases: 1, tacAvailableUnits: 20 }),
  ];
  const dec = G.planTacToAwd(rows, c, {});
  const res = G.applyPalletFill(rows, dec, c, { NEEDS: 0 }, {});
  assert.ok(res.shortfall > 0);
  assert.match(G.palletStatus(res), /SHORT by \d+ cases/);
});

test('the filler ceiling stops a case that would spike AWD cover', () => {
  const c = cfg();
  c.RULES.PALLET_FILL_MAX_AWD_DOI = 70;
  const demand = tacAwdRow({ sku: 'NEEDS', awdDoi: 50, awdQty: 500, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 });
  // 65 DOI now; one 20-unit case at rate 10 lands it on 67, still inside 70.
  const ok = tacAwdRow({ sku: 'OK', awdDoi: 65, awdQty: 650, wrDoi: 100,
    caseQty: 20, availableCases: 40, tacAvailableUnits: 800 });
  // 65 DOI, but a 100-unit case lands it on 75.
  const spike = tacAwdRow({ sku: 'SPIKE', awdDoi: 65, awdQty: 650, wrDoi: 100,
    caseQty: 100, availableCases: 40, tacAvailableUnits: 800 });

  const rows = [demand, ok, spike];
  const dec = G.planTacToAwd(rows, c, {});
  G.applyPalletFill(rows, dec, c, { NEEDS: 800, OK: 800, SPIKE: 800 }, {});
  assert.ok(dec[1].cases > 0, 'the case that stays under the ceiling goes');
  assert.equal(dec[2].cases, 0, 'the one that spikes does not');
});

// ------------------------------------------------------------ Tactical > FBA

test('Tactical > FBA stays shut when AWD is covering the need', () => {
  const row = tacFbaRow({ amzDoi: 10 });
  const awd = { 'TEST-1': { cases: 3, cappedByAwdStock: false,
    shortfallCases: 0, awdAvailableUnits: 500 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, {});
  assert.equal(d.cases, 0);
  assert.match(d.rule, /AWD is covering it/);
});

test('Tactical > FBA stays shut when AWD replenishment lands inside 14 days', () => {
  const row = tacFbaRow({ amzDoi: 10 });
  const awd = { 'TEST-1': { cases: 1, cappedByAwdStock: true,
    shortfallCases: 4, awdAvailableUnits: 0 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, { 'TEST-1': 500 });
  assert.equal(d.cases, 0);
  assert.match(d.rule, /arriving within 14 days/);
});

test('Tactical > FBA opens only on a genuine AWD shortfall', () => {
  const row = tacFbaRow({ amzDoi: 30, amzTotal: 300, rate: 10, caseQty: 20 });
  const awd = { 'TEST-1': { cases: 0, cappedByAwdStock: true,
    shortfallCases: 6, awdAvailableUnits: 0 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, {});
  assert.ok(d.cases > 0);
  assert.match(d.rule, /residual after AWD, AWD stock exhausted/);
  assert.match(G.reasonText(d, 20), /no inbound within 14 days/);
});

test('B2B and Critical raise the Tactical > FBA target to 100 DOI', () => {
  const mk = (over) => tacFbaRow({ amzDoi: 50, amzTotal: 500, rate: 10,
    caseQty: 20, availableCases: 50, ...over });
  const awd = { 'TEST-1': { cases: 0, cappedByAwdStock: true,
    shortfallCases: 6, awdAvailableUnits: 0 } };
  const plain = G.planTacToFba([mk({})], cfg(), {}, awd, {})[0];
  const b2b = G.planTacToFba([mk({ b2b: true })], cfg(), {}, awd, {})[0];
  assert.equal(plain.cases, 5);   // to 60 DOI
  assert.equal(b2b.cases, 25);    // to 100 DOI
});

test('a discontinued SKU gets the minimum viable quantity, not a top-up to 100', () => {
  // 08-10-26 101-4001: discontinued, 1-unit cases, 700 units at Tactical, AWD
  // empty, FBA on 29.5 DOI. Read as a target rather than a cap, the 100 in §7
  // pushes 205 units of a liquidating SKU into FBA. Marco typed 12.
  const row = tacFbaRow({
    sku: '101-4001', lifecycle: 'Discontinued', rate: 2.913809524,
    tacAvailableUnits: 700, availableCases: 700, amzTotal: 86,
    amzDoi: 29.51462657, caseQty: 1, awdAvailableUnits: 0,
  });
  const awd = { '101-4001': { cases: 0, cappedByAwdStock: true,
    shortfallCases: 206, awdAvailableUnits: 0 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, {});
  assert.equal(d.cases, 1);
  assert.match(G.reasonText(d, 1), /discontinued — minimum viable qty/);
});

test('a discontinued SKU already past the 100 DOI cap gets nothing', () => {
  const row = tacFbaRow({ lifecycle: 'Discontinued', amzDoi: 111.5,
    amzTotal: 84, rate: 0.75, caseQty: 36, awdAvailableUnits: 0 });
  const awd = { 'TEST-1': { cases: 0, cappedByAwdStock: true,
    shortfallCases: 3, awdAvailableUnits: 0 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, {});
  assert.equal(d.cases, 0);
  assert.match(d.rule, /already 112 DOI \(target 100\)/);
});

test('a case that would spike FBA cover is refused', () => {
  const row = tacFbaRow({ amzDoi: 55, amzTotal: 550, rate: 10, caseQty: 400 });
  const awd = { 'TEST-1': { cases: 0, cappedByAwdStock: true,
    shortfallCases: 6, awdAvailableUnits: 0 } };
  const [d] = G.planTacToFba([row], cfg(), {}, awd, {});
  assert.equal(d.cases, 0);
  assert.match(d.rule, /would reach \d+ DOI/);
});

// ------------------------------------------------------------- contention

test('below 40 FBA DOI Tactical serves FBA first, and AWD takes the remainder', () => {
  const c = cfg();
  const awdRow = tacAwdRow({ sku: 'X', tacAvailableUnits: 100, caseQty: 20,
    minUnits: 0, availableCases: 5, awdDoi: 0, wrDoi: 100 });
  const fbaRow = tacFbaRow({ sku: 'X', tacAvailableUnits: 100, caseQty: 20,
    minUnits: 0, availableCases: 5, amzDoi: 30, amzTotal: 300, rate: 10 });

  const awdDec = [G.decision(4, 'baseline 60 DOI', { pass: 'PASS_3' })];
  const fbaDec = [G.decision(3, 'residual after AWD', { pass: 'PASS_2' })];

  G.allocateTactical([awdRow], awdDec, [fbaRow], fbaDec, c);
  assert.equal(fbaDec[0].cases, 3, 'FBA is served first at 30 DOI');
  assert.equal(awdDec[0].cases, 2, 'AWD gets what is left of the 5 cases');
  assert.match(G.reasonText(awdDec[0], 20), /Tactical>FBA served first/);
});

test('above 40 FBA DOI the order reverses', () => {
  const c = cfg();
  const awdRow = tacAwdRow({ sku: 'X', tacAvailableUnits: 100, caseQty: 20,
    minUnits: 0, availableCases: 5, awdDoi: 0, wrDoi: 100 });
  const fbaRow = tacFbaRow({ sku: 'X', tacAvailableUnits: 100, caseQty: 20,
    minUnits: 0, availableCases: 5, amzDoi: 55, amzTotal: 550, rate: 10 });

  const awdDec = [G.decision(4, 'baseline 60 DOI', { pass: 'PASS_3' })];
  const fbaDec = [G.decision(3, 'residual after AWD', { pass: 'PASS_2' })];

  G.allocateTactical([awdRow], awdDec, [fbaRow], fbaDec, c);
  assert.equal(awdDec[0].cases, 4);
  assert.equal(fbaDec[0].cases, 1);
});

test('the Tactical floor binds both lanes together, not each on its own', () => {
  const c = cfg();
  // 300 units on hand, floor of 240: exactly 3 cases of 20 are drawable.
  const awdRow = tacAwdRow({ sku: 'X', tacAvailableUnits: 300, caseQty: 20,
    minUnits: 240, availableCases: 15, awdDoi: 0, wrDoi: 100 });
  const fbaRow = tacFbaRow({ sku: 'X', tacAvailableUnits: 300, caseQty: 20,
    minUnits: 240, availableCases: 15, amzDoi: 55, amzTotal: 550, rate: 10 });

  const awdDec = [G.decision(10, 'baseline 60 DOI', { pass: 'PASS_3' })];
  const fbaDec = [G.decision(4, 'residual after AWD', { pass: 'PASS_2' })];

  const { headroomUnits } = G.allocateTactical([awdRow], awdDec, [fbaRow], fbaDec, c);
  assert.equal(awdDec[0].cases + fbaDec[0].cases, 3, 'combined draw respects the floor');
  assert.equal(awdDec[0].cases, 3);
  assert.equal(fbaDec[0].cases, 0);
  assert.equal(headroomUnits.X, 0);
  assert.match(G.reasonText(fbaDec[0], 20), /Tactical floor \(min 240 units\) reached/);
});

// ------------------------------------------------- the floor, and reading it

test('an unreadable floor stops the draw instead of reading as zero', () => {
  // What actually went wrong on the first live run: the IMPORTRANGE feeding
  // column B was not yet authorised, so the floor arrived as #REF!. Read as 0
  // it let five SKUs with a floor of 100 be drawn down to nothing.
  const c = cfg();
  const awdRow = tacAwdRow({ sku: '101-2003', tacAvailableUnits: 100,
    availableCases: 5, caseQty: 20, minUnits: null, awdDoi: 32, fbaDoi: 78,
    wrDoi: 5 });
  const awdDec = [G.decision(5, 'sending all available', { pass: 'PASS_3' })];

  const res = G.allocateTactical([awdRow], awdDec, [], [], c);
  assert.equal(awdDec[0].cases, 0, 'nothing moves on a floor we cannot see');
  assert.match(awdDec[0].rule, /floor unreadable \(#REF!\)/);
  assert.deepEqual(plain(res.floorUnknown), ['101-2003']);
});

test('a known floor of zero still allows the draw', () => {
  const c = cfg();
  const awdRow = tacAwdRow({ sku: 'FREE', tacAvailableUnits: 100,
    availableCases: 5, caseQty: 20, minUnits: 0 });
  const awdDec = [G.decision(5, 'sending all available', { pass: 'PASS_3' })];
  G.allocateTactical([awdRow], awdDec, [], [], c);
  assert.equal(awdDec[0].cases, 5, 'zero is a floor; unknown is not');
});

test('only the SPD lane may dip below the floor, never the pallet lane', () => {
  // §7.1 lets Tactical > FBA rescue a critically low SKU. Tactical > AWD is
  // palletised, so it may never breach the floor to make up a pallet.
  const c = cfg();
  const shared = { sku: 'X', tacAvailableUnits: 300, minUnits: 240, caseQty: 20 };
  const awdRow = tacAwdRow({ ...shared, availableCases: 15, awdDoi: 0, wrDoi: 100 });
  const fbaRow = tacFbaRow({ ...shared, availableCases: 15, amzDoi: 10,
    amzTotal: 100, rate: 10 });

  const awdDec = [G.decision(10, 'baseline 60 DOI', { pass: 'PASS_3' })];
  const fbaDec = [G.decision(6, 'residual after AWD', { pass: 'PASS_2' })];
  fbaDec[0].floorBreachAllowed = true;
  fbaDec[0].floorBreachNote = 'AWD empty, FBA under 30 DOI';

  G.allocateTactical([awdRow], awdDec, [fbaRow], fbaDec, c);

  // FBA is served first at 10 DOI, and may reach into the 240-unit reserve.
  assert.equal(fbaDec[0].cases, 6, 'the SPD rescue goes in full');
  assert.ok(fbaDec[0].flags.includes('FLOOR_BREACH'));
  assert.match(G.reasonText(fbaDec[0], 20), /floor breached by \d+ units \(SPD\)/);
  assert.equal(awdDec[0].cases, 0, 'the pallet lane gets none of the reserve');
});

// ------------------------------------------------------------------ urgency

test('urgency is days of cover at the destination', () => {
  assert.equal(G.urgencyOf({ amzDoi: 12, awdDoi: 90 }), 12, 'FBA-bound lanes');
  assert.equal(G.urgencyOf({ awdDoi: 40 }), 40, 'Tactical > AWD');
  assert.equal(G.urgencyOf({}), 999999, 'unknown sorts last, not first');
});

test('the urgency ramp runs red to green and never skips a band', () => {
  const c = cfg();
  const seen = [5, 20, 35, 50, 75, 300].map((d) => G.urgencyColour(d, c));
  assert.equal(seen[0], '#e06666', 'about to stock out');
  assert.equal(seen[seen.length - 1], '#b6d7a8', 'months of cover');
  assert.equal(new Set(seen).size, 6, 'each band is distinct');
  for (const d of [0, 15, 60, 999999, 1e9]) {
    assert.match(G.urgencyColour(d, c), /^#[0-9a-f]{6}$/i, `no gap at ${d}`);
  }
});

test('outputs lead with whatever runs out first, not with the alphabet', () => {
  const c = cfg();
  const rows = [
    awdFbaRow({ sku: 'AAA-COMFORTABLE', amzDoi: 90, amzTotal: 900, rate: 10,
      caseQty: 20, availableCases: 50, awdAvailableUnits: 1000, awdDoi: 100 }),
    awdFbaRow({ sku: 'ZZZ-URGENT', amzDoi: 5, amzTotal: 50, rate: 10,
      caseQty: 20, availableCases: 50, awdAvailableUnits: 1000, awdDoi: 100 }),
  ];
  const dec = [G.decision(1, 'x', {}), G.decision(2, 'y', {})];
  const picks = G.accepted(rows, dec, c);
  assert.equal(picks[0].row.sku, 'ZZZ-URGENT');
  assert.equal(picks[1].row.sku, 'AAA-COMFORTABLE');

  const bySku = cfg();
  bySku.URGENCY.SORT_BY_URGENCY = false;
  assert.equal(G.accepted(rows, dec, bySku)[0].row.sku, 'AAA-COMFORTABLE');
});

// ------------------------------------------------------------------ output

test('the reason code leads with the quantity', () => {
  const d = G.decision(20, 'top-up to 100 DOI (B2B)', { pass: 'PASS_2' });
  G.addNote(d, 'capped by AWD stock');
  assert.equal(G.reasonText(d, 10), '20 cases — top-up to 100 DOI (B2B), capped by AWD stock');
  assert.equal(G.reasonText(G.decision(0, 'already 118 DOI', {}), 10), '0 — already 118 DOI');
  assert.equal(G.reasonText(G.decision(1, 'baseline 60 DOI', {}), 10), '1 case — baseline 60 DOI');
});

test('column letters map back to the spec', () => {
  const c = cfg();
  assert.equal(G.colLetter(c.COLS.TAC_TO_AWD.CASES_OUT), 'N');
  assert.equal(G.colLetter(c.COLS.TAC_TO_AWD.UNITS_OUT), 'P');
  assert.equal(G.colLetter(c.COLS.TAC_TO_AWD.REASON), 'X');
  assert.equal(G.colLetter(c.COLS.AWD_TO_FBA.CASES_OUT), 'P');
  assert.equal(G.colLetter(c.COLS.AWD_TO_FBA.UNITS_OUT), 'R');
  assert.equal(G.colLetter(c.COLS.AWD_TO_FBA.AVAILABLE_ONLY_DOI), 'Y');
  assert.equal(G.colLetter(c.COLS.AWD_TO_FBA.REASON), 'AD');
  assert.equal(G.colLetter(c.COLS.TAC_TO_FBA.CASES_OUT), 'Q');
  assert.equal(G.colLetter(c.COLS.TAC_TO_FBA.UNITS_OUT), 'S');
  assert.equal(G.colLetter(c.COLS.TAC_TO_FBA.REASON), 'Y');
});

test('a lane DSS override changes the target without touching the rules', () => {
  const c = cfg();
  c.RULES.DSS_BY_LANE.AWD_TO_FBA = 50;
  assert.equal(G.dssFor(c, 'AWD_TO_FBA'), 50);
  assert.equal(G.dssFor(c, 'TAC_TO_AWD'), 60);

  const row = awdFbaRow({ rate: 10, amzTotal: 550, amzDoi: 55, awdDoi: 100,
    caseQty: 20, availableCases: 50 });
  assert.equal(G.planAwdToFba([row], c, {})[0].cases, 0, 'past 50, nothing moves');
  const at60 = cfg();
  assert.ok(G.planAwdToFba([row], at60, {})[0].cases > 0, 'at 60 it still wants stock');
});

// -------------------------------------------- what actually shipped, or not

test('a planner name yields the date its shipment should carry', () => {
  assert.equal(G.plannerDate('08-10-26').getFullYear(), 2026);
  assert.equal(G.plannerDate('08-10-26').getMonth(), 7);
  assert.equal(G.plannerDate('08-10-26').getDate(), 10);
  // Two of the real files are named with a leading space.
  assert.ok(G.plannerDate(' 07-13-26'), 'a leading space must not defeat it');
  assert.equal(G.plannerDate('Template'), null, 'no date rather than a guess');
});

test('a CSV row is this run\'s only if its trandate is this run\'s day', () => {
  const day = G.plannerDate('08-10-26');
  assert.equal(G.isSameDay(new Date(2026, 7, 10), day), true);
  assert.equal(G.isSameDay(new Date(2026, 6, 28), day), false, 'the 07-28 rows are stale');
  assert.equal(G.isSameDay(46244, day), true, 'sheet serial for 2026-08-10');
  assert.equal(G.isSameDay(46231, day), false, 'sheet serial for 2026-07-28');
  assert.equal(G.isSameDay('', day), false, 'an empty cell is not a shipment');
  assert.equal(G.isSameDay(46244, null), false, 'no planner date, no match');
});

// ------------------------------------------------------- the Tactical floor

/** vm-realm objects have a different Object.prototype; compare structure. */
const plain = (o) => JSON.parse(JSON.stringify(o));

/** Just enough SpreadsheetApp to exercise the min-units read. */
function stubSheets(rows, tabName = 'B2B') {
  const sheet = {
    getName: () => tabName,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(...rows.map((r) => r.length), 1),
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => rows.slice(row - 1, row - 1 + numRows)
        .map((r) => Array.from({ length: numCols }, (_, i) => r[col - 1 + i] ?? '')),
    }),
  };
  const ss = { getName: () => '(Old)_Inventory Monitoring Sheets', getSheets: () => [sheet] };
  G.SpreadsheetApp = { openById: () => ss };
  return () => { delete G.SpreadsheetApp; };
}

test('the Tactical floor is read from B2B!A:E, column E, exact match', () => {
  // Mirrors the planner's own formula:
  //   =VLOOKUP(C9, IMPORTRANGE(..., "B2B!A:E"), 5, 0)
  const restore = stubSheets([
    ['101-2040', 'x', 'y', 'z', 300],
    ['101-2047', 'x', 'y', 'z', 120],
    ['101-2003', 'x', 'y', 'z', 100],
  ]);
  try {
    const got = G.readMinUnits(cfg());
    assert.deepEqual(plain(got.bySku), { '101-2040': 300, '101-2047': 120, '101-2003': 100 });
    assert.equal(got.count, 3);
    assert.match(got.source, /B2B — 3 floors/);
  } finally { restore(); }
});

test('a tab with no header row does not lose its first SKU', () => {
  // VLOOKUP over A:E neither knows nor cares about headers, so nor may this.
  const restore = stubSheets([['101-2040', '', '', '', 300]]);
  try {
    assert.deepEqual(plain(G.readMinUnits(cfg()).bySku), { '101-2040': 300 });
  } finally { restore(); }
});

test('a labelled header row is skipped rather than read as a SKU', () => {
  const c = cfg();
  const restore = stubSheets([
    ['SKU', '', '', '', 'min. units at Tactical'],
    ['101-2040', '', '', '', 300],
  ]);
  try {
    const got = G.readMinUnits(c);
    assert.deepEqual(plain(got.bySku), { '101-2040': 300 });
  } finally { restore(); }
});

test('an unreadable floor falls back to the planner, and says so', () => {
  G.SpreadsheetApp = { openById: () => { throw new Error('no access'); } };
  try {
    const got = G.readMinUnits(cfg());
    assert.deepEqual(plain(got.bySku), {});
    assert.match(got.source, /planner column B \(direct read failed: no access\)/);
  } finally { delete G.SpreadsheetApp; }
});

test('listing on the B2B tab only implies B2B when that is switched on', () => {
  const restore = stubSheets([['101-2040', '', '', '', 300]]);
  try {
    assert.deepEqual(plain(G.readMinUnits(cfg()).b2bSkus), {}, 'off by default');
    const on = cfg();
    on.MIN_UNITS.TREAT_AS_B2B = true;
    assert.deepEqual(plain(G.readMinUnits(on).b2bSkus), { '101-2040': true });
  } finally { restore(); }
});

// -------------------------------------------------------------- end to end

test('the full pipeline runs the lanes in dependency order', () => {
  const c = cfg();
  const input = {
    // AWD genuinely thin and FBA cannot cover it, so the run is justified —
    // this test is about lane ordering, not about the urgency gate.
    tacToAwd: [tacAwdRow({ sku: 'A', awdDoi: 5, fbaDoi: 20, wrDoi: 100,
      caseQty: 20, availableCases: 40, tacAvailableUnits: 800, awdInbound14: 0 })],
    awdToFba: [awdFbaRow({ sku: 'A', rate: 10, awdAvailableUnits: 40,
      availableCases: 2, awdDoi: 4, amzFulfillable: 300, amzTotal: 300,
      amzDoi: 30, caseQty: 20 })],
    tacToFba: [tacFbaRow({ sku: 'A', amzDoi: 30, amzTotal: 300, rate: 10,
      caseQty: 20, availableCases: 40, tacAvailableUnits: 800,
      awdAvailableUnits: 40 })],
    ltfIndex: {},
  };

  const plan = G.planUsTransferOrders(input, c);
  assert.equal(plan.awdToFba[0].cases, 2, 'AWD sends what it has');
  assert.ok(plan.awdToFba[0].cappedByAwdStock, 'and records that it ran out');
  assert.ok(plan.tacToFba[0].cases > 0, 'Tactical covers the residual');
  assert.ok(plan.totals.tacToAwdCases > 0);
  assert.ok(plan.pallet.demandCases > 0);
  assert.equal(typeof plan.totals.needsReview, 'number');
});
