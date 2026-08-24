/**
 * Turns the rule-test fixtures into a workbook the formulas can be evaluated
 * against.
 *
 * Only *inputs* are placed in the grid — stock, rates, case sizes, flags. The
 * derived columns get the formula strings the planner would write, so the
 * evaluator computes days of cover, cases and units exactly as the sheet does.
 * That is what makes the comparison meaningful: if the grid were pre-filled
 * with the fixtures' own `amzDoi`, the test would be checking the fixture
 * rather than the formula.
 */

import { Workbook } from './sheet-eval.js';

/** Fixture field -> lane column, for the columns a run pastes as values. */
const INPUTS = {
  TAC_TO_AWD: {
    B2B: 'b2b', MIN_UNITS: 'minUnits', NAME: 'sku', TRUE_RATE_30: 'trueRate30',
    ORDER_PLAN_RATE: 'rate', LIFECYCLE: 'lifecycle', TAC_AVAILABLE: 'tacAvailableUnits',
    WR_DOI: 'wrDoi', AWD_QTY: 'awdQty', AWD_INBOUND_14: 'awdInbound14',
    CASE_QTY: 'caseQty', FBA_DOI: 'fbaDoi',
  },
  AWD_TO_FBA: {
    B2B: 'b2b', CRITICAL: 'critical', NAME: 'sku', TRUE_RATE_30: 'trueRate30',
    ORDER_PLAN_RATE: 'rate', LIFECYCLE: 'lifecycle', AWD_AVAILABLE: 'awdAvailableUnits',
    AMZ_FULFILLABLE: 'amzFulfillable', AMZ_RESERVED: 'amzReserved',
    AMZ_INBOUND: 'amzInbound', CASE_QTY: 'caseQty',
  },
  TAC_TO_FBA: {
    B2B: 'b2b', MIN_UNITS: 'minUnits', CRITICAL: 'critical', NAME: 'sku',
    TRUE_RATE_30: 'trueRate30', ORDER_PLAN_RATE: 'rate', LIFECYCLE: 'lifecycle',
    TAC_AVAILABLE: 'tacAvailableUnits', AMZ_FULFILLABLE: 'amzFulfillable',
    AMZ_RESERVED: 'amzReserved', AMZ_INBOUND: 'amzInbound', CASE_QTY: 'caseQty',
    AWD_AVAILABLE: 'awdAvailableUnits',
  },
};

const BUILDERS = {
  TAC_TO_AWD: 'formulasTacToAwd',
  AWD_TO_FBA: 'formulasAwdToFba',
  TAC_TO_FBA: 'formulasTacToFba',
};

/**
 * `trueRate30` is absent from most fixtures, and the rule engine falls back to
 * order_plan_rate when it is. The grid has to make the same assumption or pass
 * 1 measures cover on a rate the rules never saw.
 */
function inputValue(row, field) {
  const v = row[field];
  if (v === undefined || v === null) return field === 'trueRate30' ? (row.rate ?? '') : '';
  return v;
}

function laneGrid(gs, cfg, laneKey, rows) {
  const C = cfg.COLS[laneKey];
  const first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  const build = gs.context[BUILDERS[laneKey]];
  const work = gs.context.laneWorkColumns(cfg, laneKey);

  let widest = C.REASON;
  Object.values(work).forEach((c) => { widest = Math.max(widest, c); });

  const grid = [];
  const put = (r, c, v) => {
    while (grid.length < r) grid.push(new Array(widest + 1).fill(''));
    grid[r - 1][c] = v;
  };

  // A header row, so lastRow()/MATCH have the same shape as the real tab.
  put(cfg.LAYOUT.LANE_HEADER_ROW, C.NAME, 'name');

  // Position, not the fixture's own rowIndex: the factories all default to row
  // 8, so honouring it would stack every row of a scenario on top of the first.
  rows.forEach((row, i) => {
    const at = first + i;
    Object.entries(INPUTS[laneKey]).forEach(([col, field]) => {
      put(at, C[col], inputValue(row, field));
    });
    const f = build(at, cfg);
    Object.entries(f).forEach(([col, formula]) => put(at, Number(col), formula));
  });

  return grid;
}

/**
 * Recompute the fields the sheet derives, so a fixture cannot disagree with
 * itself.
 *
 * The rule engine is handed days of cover and cases-on-hand already worked
 * out; the formulas work them out from stock and rate. A fixture that sets
 * `awdQty: 6000` and leaves `awdDoi` at the factory default of 60 describes
 * two different worlds, and comparing the two implementations across it
 * measures the fixture rather than the code. This puts both on the same row of
 * numbers before anything is compared.
 */
export function harmonise(laneKey, rows) {
  const cover = (units, rate) => (rate > 0 ? units / rate : Infinity);
  const cases = (units, cq) => (cq > 0 ? Math.floor(units / cq) : 0);

  return rows.map((r) => {
    const o = { ...r };
    if (laneKey === 'TAC_TO_AWD') {
      o.availableCases = cases(o.tacAvailableUnits, o.caseQty);
      o.awdDoi = cover((o.awdQty || 0) + (o.awdInbound14 || 0), o.rate);
    } else if (laneKey === 'AWD_TO_FBA') {
      o.availableCases = cases(o.awdAvailableUnits, o.caseQty);
      o.awdDoi = cover(o.awdAvailableUnits, o.rate);
      o.amzTotal = (o.amzFulfillable || 0) + (o.amzReserved || 0) + (o.amzInbound || 0);
      o.amzDoi = cover(o.amzTotal, o.rate);
    } else {
      o.availableCases = cases(o.tacAvailableUnits, o.caseQty);
      o.tacDoi = cover(o.tacAvailableUnits, o.rate);
      o.amzTotal = (o.amzFulfillable || 0) + (o.amzReserved || 0) + (o.amzInbound || 0);
      o.amzDoi = cover(o.amzTotal, o.rate);
    }
    return o;
  });
}

/** Named ranges as ensureSettings() would have defined them, from cfg. */
export function namedRanges(gs, cfg) {
  const names = {};
  gs.context.SETTINGS_DIALS.forEach((d) => {
    if (!d.name) return;
    names[d.name] = gs.context.getByPath_(cfg, d.path);
  });
  gs.context.SETTINGS_TABLES.forEach((t) => {
    const map = gs.context.getByPath_(cfg, t.path) || {};
    names[t.name] = Object.keys(map).map((k) => [k, map[k]]);
  });
  return names;
}

/**
 * A workbook holding all three lanes plus the Settings names.
 *
 * The two run-level cells are formulas, exactly as the Settings tab writes
 * them, so the pallet test is evaluated rather than assumed.
 */
export function buildWorkbook(gs, cfg, lanes) {
  const sheets = {};
  const laneRows = {
    TAC_TO_AWD: lanes.tacToAwd || [],
    AWD_TO_FBA: lanes.awdToFba || [],
    TAC_TO_FBA: lanes.tacToFba || [],
  };
  Object.keys(laneRows).forEach((k) => {
    sheets[cfg.TABS[k]] = laneGrid(gs, cfg, k, laneRows[k]);
  });

  const names = namedRanges(gs, cfg);
  const wb = new Workbook(sheets, names);

  // Run_TacAwdQualifyingCases and Run_TacAwdVerdict live on Settings as
  // formulas; put them in a one-cell sheet so the evaluator resolves them the
  // same way the sheet would.
  const settings = [];
  gs.context.SETTINGS_RUN_CELLS.forEach((c, i) => {
    settings.push([c.formula(cfg)]);
    Object.defineProperty(names, c.name, {
      enumerable: true,
      get: () => wb.value(cfg.TABS.SETTINGS, i + 1, 0),
    });
  });
  sheets[cfg.TABS.SETTINGS] = settings;

  return wb;
}

/** What the sheet works out for a lane's transfer column, row by row. */
export function sheetCases(wb, cfg, laneKey, rows) {
  const first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  return rows.map((r, i) => {
    const v = wb.value(cfg.TABS[laneKey], first + i, cfg.COLS[laneKey].CASES_OUT);
    return typeof v === 'number' ? v : 0;
  });
}
