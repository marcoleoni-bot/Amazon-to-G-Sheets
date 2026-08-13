/**
 * US Transfer Order Planner — all modules in one file.
 *
 * GENERATED. Do not edit here; edit apps-script/<Module>.gs and re-run
 *   node apps-script/build-bundle.mjs
 *
 * Paste this into Extensions > Apps Script as a single file, reload the
 * spreadsheet, and the Transfer Orders menu appears.
 */
// ========================================================================
// Config.gs
// ========================================================================

/**
 * Every tunable number, ID and tab name for the US transfer-order planner.
 *
 * Nothing in the rule modules hard-codes a threshold. Marco tunes DSS per run
 * today; that has to stay possible without touching logic, so the rules read
 * everything from here and the run header records what was used.
 *
 * Overrides: Script Properties (File > Project properties > Script properties)
 * beat the defaults below, so a threshold can be changed without an edit.
 * Key names are the dotted paths shown in CONFIG_OVERRIDABLE.
 */

var CONFIG = {

  // ---------------------------------------------------------------- sources

  SOURCES: {
    /** Marco's copy of the Inventory Monitoring Sheet. */
    IMS_ID: '1ErXVAoJ6LKTM7mkIWo4SYsWZscCcEwGRqbdk3tCP2So',

    /** `Transfer orders` — dated planners live under `MM. Month / US /`. */
    TRANSFER_ORDERS_FOLDER_ID: '1SemIKHHXlDazC8q0TbIjxD0cvxkLY-CU',

    /** Workbook holding the per-SKU Tactical floor. */
    MIN_UNITS_ID: '14fW_-GacyK_8JDRE9Z1EomAE87S0rpnsJ9WkxKw7lCE',

    /**
     * Where the append-only TO history lives. Its own workbook, so the record
     * outlives any single planner; blank keeps it in the planner instead,
     * which forgets as fast as the file does.
     */
    HISTORY_ID: '',

    /**
     * Other workbooks this planner imports from. The authoriser also scans the
     * sheet's own formulas, so this is a safety net for a source that is not
     * referenced by an IMPORTRANGE the scan can see.
     */
    EXTRA_IMPORT_SOURCES: [
      '1CEMazWrjCanl6Cbld6xpCEl8UOVomNXTbl8-CD7luB0', // Staging_Rates
    ],

    /**
     * Where the lane input columns are read from.
     *
     *   'planner' — read the planner's own lane tabs, which the template
     *               populates from the IMS with the formulas already in it.
     *               This is the default because it is also what makes a
     *               back-test possible: a past planner carries its own
     *               snapshot, the IMS does not.
     *   'ims'     — read the IMS lane tabs directly (§10.1). Same layout, so
     *               the same reader serves it; fill in IMS_LANE_TABS below.
     */
    LANES_FROM: 'planner',

    /** Only needed when LANES_FROM is 'ims'. Layout must match §3. */
    IMS_LANE_TABS: {
      TAC_TO_AWD: '',
      AWD_TO_FBA: '',
      TAC_TO_FBA: '',
    },
  },

  /**
   * The per-SKU Tactical floor, read straight from MIN_UNITS_ID rather than
   * through the planner's IMPORTRANGE (§2).
   *
   * Confirmed from the formula in the planner's own column B:
   *
   *   =VLOOKUP(C9, IMPORTRANGE("...14fW_-Gacy...", "B2B!A:E"), 5, 0)
   *
   * So: tab `B2B`, SKU in column A, floor in column E, exact match. Note what
   * that tab being named B2B implies — only B2B products carry a floor, which
   * matches the planner, where column B is blank for everything else.
   *
   * If the read fails the reader falls back to the planner's column B and says
   * so in the run header, rather than treating a missing floor as zero.
   */
  MIN_UNITS: {
    TAB: 'B2B',
    /** Column letters, used when the header text below is not matched. */
    SKU_COL: 0,   // A
    UNITS_COL: 4, // E
    /** Optional: if both are found in row 1, that row is treated as a header. */
    SKU_HEADER: 'SKU',
    UNITS_HEADER: 'min. units at Tactical',

    /**
     * Whether being listed on that tab counts as a B2B flag.
     *
     * Off by default. Column A of each lane is already the authoritative B2B
     * flag and back-tests clean, so inferring it a second way can only add
     * false positives — and a false B2B flag silently moves a SKU to the 100
     * DOI target. Turn this on once someone confirms the tab holds B2B SKUs
     * and nothing else.
     */
    TREAT_AS_B2B: false,
  },

  // ------------------------------------------------------------------- tabs

  TABS: {
    // Note the trailing space on the Tactical > AWD tab. It is real.
    TAC_TO_AWD: 'US TO Tactical > AWD ',
    AWD_TO_FBA: 'US TO AWD > FBA',
    TAC_TO_FBA: 'US TO Tactical > FBA',

    SUMMARY_TAC_AWD: 'To transfer Tac-AWD',
    SUMMARY_AWD_FBA: 'AWD TO FBA',
    SUMMARY_TAC_FBA: 'To transfer Tac-FBA',

    CSV_TAC_AWD: 'CSV upload TACTICAL AWD',
    CSV_TAC_FBA: 'CSV upload TACTICAL FBA',
    CSV_TO_TACTICAL: 'CSV to Tactical',

    LTF: 'LTF',
    CRITICAL: 'CRITICAL',
    PRODUCTS: 'Copy of Sheet1',
    // The B2B tab is not here: it lives in the min-units workbook, and is the
    // same tab the Tactical floor comes from. See MIN_UNITS.TAB.

    RUN_HEADER: 'Run header',
    HISTORY: 'TO history',
  },

  /** Header row and first data row, per §3. Lanes share these. */
  LAYOUT: {
    LANE_HEADER_ROW: 7,
    LANE_FIRST_DATA_ROW: 8,

    LTF_HEADER_ROW: 3,
    CRITICAL_HEADER_ROW: 3,
    PRODUCTS_HEADER_ROW: 1,
    SUMMARY_HEADER_ROW: 1,
    CSV_HEADER_ROW: 1,
  },

  /**
   * Column indexes, 0-based, exactly as §3 lays them out.
   * `REASON` is the new column immediately right of the last used one.
   */
  COLS: {
    TAC_TO_AWD: {
      B2B: 0,             // A
      MIN_UNITS: 1,       // B
      NAME: 2,            // C
      MKT: 3,             // D
      TRUE_RATE_30: 4,    // E
      ORDER_PLAN_RATE: 5, // F
      LIFECYCLE: 6,       // G
      TAC_AVAILABLE: 7,   // H  units
      AVAILABLE_CASES: 8, // I
      WR_DOI: 9,          // J
      AWD_QTY: 10,        // K
      AWD_INBOUND_14: 11, // L
      AWD_DOI: 12,        // M  (available + inbound)
      CASES_OUT: 13,      // N  <- written
      CASE_QTY: 14,       // O
      UNITS_OUT: 15,      // P  <- written
      CONTROL: 16,        // Q
      TOTAL_DOI: 17,      // R
      AWD_DOI_AFTER: 18,  // S
      FBA_DOI: 21,        // V
      REASON: 23,         // X  <- written
    },

    AWD_TO_FBA: {
      B2B: 0,             // A
      CRITICAL: 1,        // B
      NAME: 2,            // C
      MKT: 3,             // D
      TRUE_RATE_30: 4,    // E
      ORDER_PLAN_RATE: 5, // F
      LIFECYCLE: 6,       // G
      AWD_AVAILABLE: 7,   // H  units
      AVAILABLE_CASES: 8, // I
      AWD_DOI: 9,         // J
      AMZ_FULFILLABLE: 10,// K  fulfillable + receiving
      AMZ_RESERVED: 11,   // L
      AMZ_INBOUND: 12,    // M
      AMZ_TOTAL: 13,      // N
      AMZ_DOI: 14,        // O
      CASES_OUT: 15,      // P  <- written
      CASE_QTY: 16,       // Q
      UNITS_OUT: 17,      // R  <- written
      CONTROL: 18,        // S
      TOTAL_DOI: 19,      // T
      AMZ_DOI_AFTER: 20,  // U
      RESERVED_RATIO: 23, // X
      AVAILABLE_ONLY_DOI: 24, // Y  <- recomputed on order_plan_rate (§4)
      REASON: 29,         // AD <- written
    },

    TAC_TO_FBA: {
      B2B: 0,             // A
      MIN_UNITS: 1,       // B
      CRITICAL: 2,        // C
      NAME: 3,            // D
      MKT: 4,             // E
      TRUE_RATE_30: 5,    // F
      ORDER_PLAN_RATE: 6, // G
      LIFECYCLE: 7,       // H
      TAC_AVAILABLE: 8,   // I  units
      AVAILABLE_CASES: 9, // J
      TAC_DOI: 10,        // K
      AMZ_FULFILLABLE: 11,// L
      AMZ_RESERVED: 12,   // M
      AMZ_INBOUND: 13,    // N
      AMZ_TOTAL: 14,      // O
      AMZ_DOI: 15,        // P
      CASES_OUT: 16,      // Q  <- written
      CASE_QTY: 17,       // R
      UNITS_OUT: 18,      // S  <- written
      CONTROL: 19,        // T
      TOTAL_DOI: 20,      // U
      AMZ_DOI_AFTER: 21,  // V
      AWD_AVAILABLE: 22,  // W
      TO_AWD_TO_FBA: 23,  // X
      REASON: 24,         // Y  <- written
    },

    /** LTF: header on row 3, SKU in B, market in A, the comment in Q. */
    LTF: { MARKET: 0, SKU: 1, DESCRIPTION: 2, COMMENT: 16 },

    /** CRITICAL: header on row 3, SKU list in B. */
    CRITICAL: { SKU: 1 },

    /** Copy of Sheet1: name -> Amazon SKU, case size, discontinued flag. */
    PRODUCTS: { NAME: 0, AMAZON_SKU: 1, CASE_QTY: 4, DISCONTINUED: 16 },
  },

  // -------------------------------------------------------------- rule dials

  RULES: {
    /** Baseline days-of-inventory target for ordinary SKUs. */
    DSS: 60,

    /**
     * Tactical > AWD, as actually worked by hand.
     *
     * The lane is not the generic ladder. It looks at SKUs that are short at
     * BOTH ends — under 100 days at AWD *and* under 100 at FBA — and tops the
     * AWD end to 75, not to the 60 baseline. A SKU thin at AWD but comfortable
     * at FBA is not a reason to move a pallet; that is the same judgement the
     * urgency gate makes, expressed as the entry filter.
     */
    TAC_TO_AWD_GATE_AWD_DOI: 100,
    TAC_TO_AWD_GATE_FBA_DOI: 100,
    TAC_TO_AWD_TARGET_DOI: 75,

    /**
     * Per-lane DSS override. Null means "use DSS".
     * The 08-10 planner ran AWD>FBA at 50; set it here to reproduce that run
     * rather than editing the rules.
     */
    DSS_BY_LANE: {
      TAC_TO_AWD: null,
      AWD_TO_FBA: null,
      TAC_TO_FBA: null,
    },

    /** Top-up target for B2B and Critical SKUs (§5 pass 2, §7). */
    PRIORITY_DOI: 100,

    /**
     * How thin a B2B/Critical SKU must get before pass 2 tops it back up.
     *
     * §5 gives pass 2 no DOI trigger — the gate is "B2B or Critical", so a
     * priority SKU is pushed to 100 DOI on every run, including one already
     * sitting at 88. Across six back-tested runs that is the single largest
     * source of over-shipping against what actually left AWD.
     *
     * null keeps the spec's behaviour, which is the default because the spec
     * is what was signed off. Set it to a number (60 is the obvious candidate)
     * to fire pass 2 only once cover has dropped below it. See the README —
     * this is the open question with the most volume behind it.
     */
    PASS2_TRIGGER_DOI: 100,

    /**
     * Pass 1: reserved-blocked.
     *
     * Trigger and target are different numbers. A SKU qualifies when its
     * available-only cover is under 40 days; the top-up then aims at 42. Using
     * one number for both would keep re-triggering SKUs it had just filled.
     */
    /**
     * Pass 1 measures available-only cover on true_rate_30, not on
     * order_plan_rate — that is what the sheet's own formula does
     * (ROUNDUP((42-Y)*E/Q) with Y = K/E), and it is what reproduces the worked
     * numbers. On 08-13, 101-1068 is 2 cases on the true rate and 5 on the
     * order plan rate; 2 is what shipped.
     *
     * The 110 ceiling is still measured on order_plan_rate, because that is the
     * cover figure the lane reports. The distinction decides real rows:
     * 101-1062 lands on 112 DOI by the order plan rate and was held, but on 104
     * by the true rate, which would have sent it.
     */
    PASS1_RATE: 'true_rate_30',  // 'true_rate_30' | 'order_plan_rate'
    PASS1_RESERVED_RATIO: 0.5,   // reserved / fulfillable must exceed this
    PASS1_TRIGGER_DOI: 40,       // available-only cover under this qualifies
    PASS1_AVAILABLE_DOI: 42,     // and the top-up aims here

    /**
     * The one ceiling every AWD > FBA pass respects: total FBA cover after the
     * transfer. Cases come off until the result fits; if that leaves none, none
     * are sent and the row is flagged rather than quietly dropped.
     */
    MAX_FBA_DOI_AFTER: 110,

    /** Pass 2: flag when the suggestion eats this share of AWD stock. */
    PASS2_LARGE_SHARE_OF_AWD: 0.5,

    /**
     * Pass 2 flags a priority SKU sitting under this before the transfer.
     * Being that thin on a B2B or Critical line usually means the rate is
     * inflated, and that is worth a second look before it ships.
     */
    PASS2_FLAG_BELOW_DOI: 70,

    /** Pass 3: propose it, but ask for a second look above this. */
    REVIEW_ABOVE_CASES: 7,

    /** Tactical>AWD ships on pallets. */
    PALLET_MIN_CASES: 25,
    PALLET_FILL_MAX_AWD_DOI: 100,
    PALLET_FILL_MAX_CASES_PER_SKU: 2,

    /**
     * Whether a Tactical>AWD run is worth raising at all.
     *
     * The pallet minimum is a constraint on a shipment, not a reason to make
     * one. Read the other way round it produces exactly the wrong answer: five
     * cases of genuine need, padded with twenty cases of SKUs that did not need
     * anything, purely to fill the pallet. That is more work, more freight and
     * more stock sitting at AWD than doing nothing would have been.
     *
     * So the lane asks first whether anything is actually running thin. A SKU
     * on 40 days of AWD cover with FBA healthy behind it is not urgent — it can
     * wait for a run where something is. Only once a run is justified does the
     * pallet minimum apply, and the fill tops it up, because by then the pallet
     * is being paid for regardless.
     *
     * Across six back-tested runs Tactical shipped once. Filling on demand
     * alone proposed a load every single run.
     *
     * Both conditions must hold. AWD exists to feed FBA, so an empty shelf at
     * AWD is only a problem when FBA cannot cover the gap — 101-2102 carries no
     * AWD stock at all, which reads as 0 days of cover, while sitting on 599
     * days at FBA and selling a sixth of a unit a day. Treating "0 DOI at AWD"
     * as an emergency on its own turns the quietest SKU in the catalogue into
     * the loudest, and justifies a pallet every single week.
     */
    TAC_TO_AWD_URGENCY_AWD_DOI: 30,   // AWD cover below this is thin
    TAC_TO_AWD_HEALTHY_FBA_DOI: 60,   // ...and only matters if FBA is this thin

    /** Contention: below this FBA DOI, Tactical serves FBA before AWD (§8). */
    FBA_DOI_CONTENTION: 40,

    /**
     * Discontinued stock going Tactical > FBA is being liquidated, not
     * replenished. Send it down, but never past 110 days of cover, and aim to
     * stay under 50 — if even one case would cross 110, send none.
     */
    DISCONTINUED_MAX_FBA_DOI: 110,
    DISCONTINUED_AIM_FBA_DOI: 50,

    /**
     * Per-SKU unit floors at FBA that exist for reasons no DOI figure knows
     * about. 101-4001 is held at 100 units on a marketing call.
     */
    FBA_MIN_UNITS_BY_SKU: { '101-4001': 100 },

    /** Tactical>FBA floor-breach exception (§7.1). */
    FLOOR_BREACH_MAX_FBA_DOI: 30,
    FLOOR_BREACH_RESTORE_DOI: 60,
    /** How far off "roughly 60 DOI" still counts as restoring the baseline. */
    FLOOR_BREACH_RESTORE_TOLERANCE: 0.25,

    /**
     * §7 gate 4, "the resulting FBA DOI does not spike", needs a ceiling.
     * Pass 1 gives the only worked example of how far an indivisible case may
     * overshoot a target: 100 -> 110. That ratio is reused here, so the
     * ceiling is 1.1x whichever target applies.
     */
    TAC_TO_FBA_SPIKE_MULTIPLIER: 1.1,

    /**
     * §7 states the Tactical>FBA quantity two ways: "the smaller of 1 case and
     * the cases to reach target", then "1 case, unless more is needed to reach
     * the target". Its own worked example is 4 cases, so the second reading
     * governs by default.
     *
     *   'to_target'   — at least 1 case, up to the target. (default)
     *   'single_case' — never more than 1 case.
     */
    TAC_TO_FBA_QTY_MODE: 'to_target',

    /**
     * §4: the run is one snapshot, so Tactical>AWD computed in this run is not
     * treated as AWD replenishment when gating Tactical>FBA.
     */
    TAC_TO_FBA_COUNTS_THIS_RUN_AS_INBOUND: false,
  },

  OUTPUT: {
    /** Regenerate the summary and CSV tabs from the accepted numbers. */
    WRITE_SUMMARIES: true,
    WRITE_CSV_TABS: true,

    /** Write the recomputed available-only DOI back into column Y (§4). */
    WRITE_RECOMPUTED_Y: true,

    /**
     * LTF rows carry their comment into the summary tabs' LTF column, which is
     * what those columns are for. Set false to hold them off the pick list.
     */
    LTF_IN_SUMMARIES: true,

    SHIP_METHOD_TAC_AWD: 'Amazon partnered carrier',
    SHIP_METHOD_TAC_FBA: 'Amazon inbound parcel',
  },

  /** §9.3. Any legible scheme is acceptable; this is the one in use. */
  COLOURS: {
    PASS_1: '#cfe2f3',       // light blue  — reserved-blocked
    PASS_2: '#d9ead3',       // light green — B2B / Critical
    PASS_3: null,            // no fill     — baseline
    NEEDS_REVIEW: '#fce5cd', // amber
    LTF: '#f4cccc',          // red
    PALLET_FILL: '#efefef',  // light grey
    FLOOR_BREACH_BORDER: '#cc0000',
    HEADER: '#d0e0e3',
  },

  /**
   * Urgency, as days of cover at the destination, painted as a ramp.
   *
   * Read top to bottom: the first band a SKU falls into wins. Deep red is
   * about to stock out, green has months of cover. The outputs are sorted on
   * the same number, so the pick list opens on whatever is closest to running
   * out rather than on whatever sorts first alphabetically.
   */
  URGENCY: {
    BANDS: [
      { upTo: 15, colour: '#e06666' },
      { upTo: 30, colour: '#f6b26b' },
      { upTo: 45, colour: '#ffd966' },
      { upTo: 60, colour: '#ffe599' },
      { upTo: 90, colour: '#d9ead3' },
      { upTo: 999999, colour: '#b6d7a8' },
    ],
    /** Tint the summary tabs as well as the lane tabs. */
    TINT_SUMMARIES: true,
    /** Sort every output most-urgent-first. */
    SORT_BY_URGENCY: true,
  },

  /** Month folder names under `Transfer orders`, e.g. `08. August`. */
  MONTH_FOLDERS: ['01. January', '02. February', '03. March', '04. April',
    '05. May', '06. June', '07. July', '08. August',
    '09. September', '10. October', '11. November', '12. December'],

  MARKET: 'US',
  TIMEZONE: 'America/New_York',
};

/** Script Property keys that may override a CONFIG value, by dotted path. */
var CONFIG_OVERRIDABLE = [
  'RULES.DSS',
  'RULES.DSS_BY_LANE.TAC_TO_AWD',
  'RULES.DSS_BY_LANE.AWD_TO_FBA',
  'RULES.DSS_BY_LANE.TAC_TO_FBA',
  'RULES.PRIORITY_DOI',
  'RULES.PASS2_TRIGGER_DOI',
  'RULES.PASS1_RESERVED_RATIO',
  'RULES.PASS1_RATE',
  'RULES.PASS1_TRIGGER_DOI',
  'RULES.PASS1_AVAILABLE_DOI',
  'RULES.MAX_FBA_DOI_AFTER',
  'RULES.TAC_TO_AWD_TARGET_DOI',
  'RULES.TAC_TO_AWD_GATE_AWD_DOI',
  'RULES.TAC_TO_AWD_GATE_FBA_DOI',
  'RULES.PASS2_LARGE_SHARE_OF_AWD',
  'RULES.REVIEW_ABOVE_CASES',
  'RULES.PALLET_MIN_CASES',
  'RULES.PALLET_FILL_MAX_AWD_DOI',
  'RULES.PALLET_FILL_MAX_CASES_PER_SKU',
  'RULES.FBA_DOI_CONTENTION',
  'RULES.TAC_TO_FBA_QTY_MODE',
  'SOURCES.LANES_FROM',
  'MIN_UNITS.TAB',
];

/**
 * CONFIG with any Script Property overrides applied. Call this rather than
 * reading CONFIG directly, so an override always takes effect.
 */
function config() {
  var cfg = JSON.parse(JSON.stringify(CONFIG));
  var props;
  try {
    props = PropertiesService.getScriptProperties().getProperties();
  } catch (e) {
    return cfg; // not inside Apps Script (unit tests)
  }
  CONFIG_OVERRIDABLE.forEach(function (path) {
    if (!Object.prototype.hasOwnProperty.call(props, path)) return;
    var raw = props[path];
    var value = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw));
    setByPath(cfg, path, value);
  });
  return cfg;
}

function setByPath(obj, path, value) {
  var parts = path.split('.');
  var node = obj;
  for (var i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}

/** The DSS in force for a lane: the lane override, else the baseline. */
function dssFor(cfg, laneKey) {
  var override = cfg.RULES.DSS_BY_LANE[laneKey];
  return (override === null || override === undefined || override === '')
    ? cfg.RULES.DSS
    : Number(override);
}

// ========================================================================
// Lib.gs
// ========================================================================

/**
 * Small pure helpers shared by the rule modules.
 *
 * Nothing here touches SpreadsheetApp, so the whole rule layer runs unchanged
 * under `npm test`.
 */

/** Sheet error literals that must not be read as data. */
var SHEET_ERRORS = ['#N/A', '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!',
  '#NULL!', '#ERROR!', 'No Rate', 'Loading...'];

function isSheetError(v) {
  return typeof v === 'string' && SHEET_ERRORS.indexOf(v.trim()) !== -1;
}

/**
 * A cell as a number. Blanks and sheet errors become `fallback` (0 by default)
 * rather than NaN, because a NaN silently poisons every comparison downstream.
 */
function num(v, fallback) {
  var d = (fallback === undefined) ? 0 : fallback;
  if (v === null || v === undefined || v === '') return d;
  if (typeof v === 'number') return isFinite(v) ? v : d;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isSheetError(v)) return d;
  var n = Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : d;
}

/** TRUE / "TRUE" / "YES" / "T" / 1 all mean true. */
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  var s = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === 'Y' || s === 'T' || s === '1';
}

/** SKUs are compared case-insensitively with surrounding space ignored. */
function normSku(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/** ROUNDUP(x, 0) as Sheets does it: away from zero. */
function roundUp(x) {
  if (!isFinite(x)) return 0;
  return x < 0 ? -Math.ceil(-x) : Math.ceil(x);
}

/** Cases that fit in `units` at `caseQty` per case. */
function casesIn(units, caseQty) {
  if (caseQty <= 0) return 0;
  return Math.floor(units / caseQty);
}

/** Days of inventory. No rate means no finite DOI, which is not the same as 0. */
function doi(units, rate) {
  if (!(rate > 0)) return Infinity;
  return units / rate;
}

function clampMin0(n) {
  return n > 0 ? n : 0;
}

/**
 * The standard DSS ladder used by Tactical>AWD and by AWD>FBA pass 3.
 *
 *   sourceDoi      days of cover at the source  (J on both lanes)
 *   destDoi        days of cover at the destination
 *   availableCases cases on hand at the source
 *   rate           order_plan_rate
 *   caseQty        units per case
 *
 * Mirrors the sheet's IFS in order, including its quirk that a destination
 * sitting exactly on the target yields one case rather than none.
 */
function dssLadder(dss, sourceDoi, destDoi, availableCases, rate, caseQty) {
  if (sourceDoi + destDoi < dss) return availableCases;
  if (dss - destDoi < 0) return 0;
  if ((dss - destDoi) * rate < caseQty) return 1;
  if (dss - destDoi > 0) return roundUp((dss - destDoi) * rate / caseQty);
  return 0;
}

/**
 * A decision, in the shape every lane returns.
 * `notes` are the constraint clauses appended to the reason after the rule.
 */
function decision(cases, rule, opts) {
  var o = opts || {};
  return {
    cases: cases,
    rule: rule,
    notes: o.notes || [],
    pass: o.pass || null,
    flags: o.flags || [],
  };
}

function addNote(d, note) {
  if (note) d.notes.push(note);
  return d;
}

function addFlag(d, flag) {
  if (d.flags.indexOf(flag) === -1) d.flags.push(flag);
  return d;
}

/**
 * The date a planner is for, from its name — `08-10-26`, sometimes with a
 * stray leading space. Returns null when the name is not a date, in which case
 * callers fall back to today rather than guessing.
 */
function plannerDate(name) {
  var m = String(name || '').trim().match(/(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

/** Whether a cell holding a date or a sheet serial falls on `date`. */
function isSameDay(cell, date) {
  if (!date) return false;
  var d = cell;
  if (typeof cell === 'number') {
    d = new Date(Date.UTC(1899, 11, 30) + cell * 86400000);
    return d.getUTCFullYear() === date.getFullYear()
      && d.getUTCMonth() === date.getMonth()
      && d.getUTCDate() === date.getDate();
  }
  if (!(d instanceof Date)) return false;
  return d.getFullYear() === date.getFullYear()
    && d.getMonth() === date.getMonth()
    && d.getDate() === date.getDate();
}

/** Round for display without dragging in a locale. */
function fmt(n, places) {
  var p = places === undefined ? 0 : places;
  if (!isFinite(n)) return '∞';
  var r = Math.round(n * Math.pow(10, p)) / Math.pow(10, p);
  return String(r);
}

/**
 * `<qty> — <rule>[, <constraint>]`, per §9.2.
 * The quantity leads because that is what gets read first when scanning down.
 */
function reasonText(d, caseQty) {
  var qty = d.cases === 0
    ? '0'
    : d.cases + (d.cases === 1 ? ' case' : ' cases');
  var parts = [qty + ' — ' + d.rule];
  var line = parts[0];
  if (d.notes.length) line += ', ' + d.notes.join(', ');
  if (d.flags.indexOf('NEEDS_REVIEW') !== -1) line += '  ⚠ review';
  if (d.flags.indexOf('FLOOR_BREACH') !== -1) line += '  ⚠ FLOOR BREACH';
  return line;
}

// ========================================================================
// Rules_AwdToFba.gs
// ========================================================================

/**
 * Lane: AWD -> FBA (§5).
 *
 * Three passes, in order, and a SKU claimed by an earlier pass is skipped by
 * the later ones. AWD stock is decremented as it is claimed (§8), which only
 * bites when the same SKU appears on more than one row — but when it does, the
 * second row must not spend stock the first already committed.
 */

function planAwdToFba(rows, cfg, ltfIndex) {
  var dss = dssFor(cfg, 'AWD_TO_FBA');
  var R = cfg.RULES;

  // Remaining AWD units per SKU, so repeated rows cannot double-spend.
  var remaining = {};
  rows.forEach(function (r) {
    var k = normSku(r.sku);
    if (!(k in remaining)) remaining[k] = r.awdAvailableUnits;
  });

  var out = rows.map(function () { return null; });

  // ---- pass 1: reserved-blocked -----------------------------------------
  rows.forEach(function (r, i) {
    if (out[i]) return;
    if (!hasRate(r)) return;
    var y = availableOnlyDoi(r, R);
    if (!reservedBlocked(r, y, R)) return;
    out[i] = pass1(r, y, dss, R, remaining);
  });

  // ---- pass 2: B2B and Critical -----------------------------------------
  rows.forEach(function (r, i) {
    if (out[i]) return;
    if (!hasRate(r)) return;
    if (!(r.b2b || r.critical)) return;
    // A priority SKU that is still comfortable does not need topping up; see
    // PASS2_TRIGGER_DOI. null means the spec's behaviour — always.
    if (R.PASS2_TRIGGER_DOI !== null && R.PASS2_TRIGGER_DOI !== undefined
        && r.amzDoi >= R.PASS2_TRIGGER_DOI) return;
    out[i] = pass2(r, R, remaining);
  });

  // ---- pass 3: everything else ------------------------------------------
  rows.forEach(function (r, i) {
    if (out[i]) return;
    if (!hasRate(r)) { out[i] = noRate(r); return; }
    out[i] = pass3(r, dss, R, remaining);
  });

  // ---- what FBA is still short of, and whether AWD could have fixed it ---
  rows.forEach(function (r, i) {
    markResidualNeed(out[i], r, cfg, dss, remaining);
  });

  // ---- LTF overlay, all passes ------------------------------------------
  rows.forEach(function (r, i) {
    applyLtf(out[i], r, ltfIndex);
  });

  return out;
}

/**
 * Records what this lane left on the table, which is the question Tactical>FBA
 * gate 1 asks (§7).
 *
 * "Could not cover it" has to mean *AWD had nothing left*, not merely "the
 * number came out lower than the raw want". Pass 1's 100/110 ceilings and the
 * priority target are policy: hitting one of those is a decision, not a
 * shortage, and must not open the residual lane. So the shortfall counts only
 * when the stock still sitting in AWD could not have supplied it.
 *
 * The case this exists for: the ladder's first branch ships every available
 * case and FBA is *still* under target. The request was met in full, nothing
 * was clipped, and AWD is empty — which is exactly a shortage.
 */
function markResidualNeed(d, r, cfg, dss, remaining) {
  if (!d) return;
  var target = (r.b2b || r.critical) ? cfg.RULES.PRIORITY_DOI : dss;
  var sent = d.cases > 0 ? d.cases : 0;
  var needed = clampMin0(roundUp((target - r.amzDoi) * r.rate / r.caseQty));
  var shortfall = clampMin0(needed - sent);
  var free = remaining[normSku(r.sku)];
  if (free === undefined) free = r.awdAvailableUnits;

  d.shortfallCases = shortfall;
  d.cappedByAwdStock = shortfall > 0 && free < shortfall * r.caseQty;
}

// --------------------------------------------------------------------- gates

function hasRate(r) {
  return r.rate > 0;
}

function noRate(r) {
  return decision(0, 'no order_plan_rate', { pass: 'NONE' });
}

/** The rate pass 1 works in. See Config.RULES.PASS1_RATE. */
function pass1Rate(r, R) {
  return (R.PASS1_RATE === 'order_plan_rate' || !(r.trueRate30 > 0))
    ? r.rate : r.trueRate30;
}

/** Y — days of cover on fulfillable stock alone. */
function availableOnlyDoi(r, R) {
  return doi(r.amzFulfillable, pass1Rate(r, R));
}

/** X — reserved against fulfillable. All reserved and none fulfillable counts. */
function reservedRatio(r) {
  if (r.amzFulfillable > 0) return r.amzReserved / r.amzFulfillable;
  return r.amzReserved > 0 ? Infinity : 0;
}

function reservedBlocked(r, y, R) {
  return reservedRatio(r) > R.PASS1_RESERVED_RATIO && y < R.PASS1_TRIGGER_DOI;
}

/**
 * Take cases off until total FBA cover after the transfer fits under the
 * ceiling. Returns the largest n that fits, which may be zero — and zero is a
 * real answer here, not a failure: stock is available but sending any of it
 * would overshoot.
 */
function fitUnderCeiling(want, r, R) {
  var n = want;
  while (n > 0 && doi(r.amzTotal + n * r.caseQty, r.rate) > R.MAX_FBA_DOI_AFTER) n--;
  return n;
}

// --------------------------------------------------------------------- passes

/**
 * Pass 1 — stock is on hand but reserved, so the sellable cover is thin.
 * Top the *available-only* cover up to 42 days, then hold total cover to 100,
 * except that a single indivisible case may land as high as 110.
 */
function pass1(r, y, dss, R, remaining) {
  var pr = pass1Rate(r, R);
  var want = clampMin0(roundUp((R.PASS1_AVAILABLE_DOI - y) * pr / r.caseQty));
  var rule = 'reserved-blocked, top-up available-only to '
    + R.PASS1_AVAILABLE_DOI + ' DOI';

  var fits = fitUnderCeiling(want, r, R);

  if (fits === 0) {
    // Stock is there and the available-only cover says send — but even one
    // case overshoots. Marco flags these in red rather than losing them.
    var oneCase = doi(r.amzTotal + r.caseQty, r.rate);
    var d0 = decision(0, 'reserved-blocked but 1 case reaches ' + fmt(oneCase)
      + ' DOI (>' + R.MAX_FBA_DOI_AFTER + ')', { pass: 'PASS_1' });
    addNote(d0, fmt(100 * reservedRatio(r)) + '% of FBA stock reserved');
    addFlag(d0, 'RESERVED_BLOCKED');
    addFlag(d0, 'NEEDS_REVIEW');
    return d0;
  }

  var d = decision(fits, rule, { pass: 'PASS_1' });
  if (fits < want) {
    addNote(d, 'held to ' + R.MAX_FBA_DOI_AFTER + ' DOI');
  }
  return capToStock(d, r, remaining);
}

/** Pass 2 — B2B and Critical SKUs are held at 100 days of cover. */
function pass2(r, R, remaining) {
  var want = clampMin0(roundUp((R.PRIORITY_DOI - r.amzDoi) * r.rate / r.caseQty));
  var why = r.b2b && r.critical ? 'B2B + Critical' : (r.b2b ? 'B2B' : 'Critical');

  if (want === 0) {
    return decision(0, 'already ' + fmt(r.amzDoi) + ' DOI (' + why + ' target '
      + R.PRIORITY_DOI + ')', { pass: 'PASS_2' });
  }

  var d = decision(want, 'top-up to ' + R.PRIORITY_DOI + ' DOI (' + why + ')',
    { pass: 'PASS_2' });
  var before = d.cases;
  capToStock(d, r, remaining);

  var stockCases = casesIn(r.awdAvailableUnits, r.caseQty);
  if (d.cases < before || (stockCases > 0 && d.cases >= stockCases)) {
    addNote(d, 'sending all AWD stock');
    addFlag(d, 'NEEDS_REVIEW');
  } else if (stockCases > 0 && d.cases / stockCases >= R.PASS2_LARGE_SHARE_OF_AWD) {
    addNote(d, 'takes ' + fmt(100 * d.cases / stockCases) + '% of AWD stock');
    addFlag(d, 'NEEDS_REVIEW');
  }
  // Sitting this thin on a priority line usually means the rate is inflated.
  if (r.amzDoi < R.PASS2_FLAG_BELOW_DOI) {
    addNote(d, 'only ' + fmt(r.amzDoi) + ' DOI before transfer — check the rate');
    addFlag(d, 'NEEDS_REVIEW');
  }
  return d;
}

/** Pass 3 — the standard ladder at the baseline target. */
function pass3(r, dss, R, remaining) {
  var want = dssLadder(dss, r.awdDoi, r.amzDoi, r.availableCases, r.rate, r.caseQty);
  want = clampMin0(want);

  var rule;
  if (want === 0) {
    rule = 'already ' + fmt(r.amzDoi) + ' DOI';
    return decision(0, rule, { pass: 'PASS_3' });
  }
  rule = (r.awdDoi + r.amzDoi < dss)
    ? 'AWD + FBA under ' + dss + ' DOI, sending all available'
    : 'baseline ' + dss + ' DOI';

  var fits = fitUnderCeiling(want, r, R);
  if (fits === 0) {
    return decision(0, '1 case would reach '
      + fmt(doi(r.amzTotal + r.caseQty, r.rate)) + ' DOI (>'
      + R.MAX_FBA_DOI_AFTER + ')', { pass: 'PASS_3' });
  }

  var d = decision(fits, rule, { pass: 'PASS_3' });
  if (fits < want) addNote(d, 'held to ' + R.MAX_FBA_DOI_AFTER + ' DOI');
  capToStock(d, r, remaining);

  if (d.cases > R.REVIEW_ABOVE_CASES) {
    addNote(d, 'over ' + R.REVIEW_ABOVE_CASES + ' cases');
    addFlag(d, 'NEEDS_REVIEW');
  }
  return d;
}

// ----------------------------------------------------------------- stock caps

/**
 * Cap C — never more than the cases actually sitting in AWD, and never more
 * than this SKU has left after earlier rows claimed their share.
 */
function capToStock(d, r, remaining) {
  var key = normSku(r.sku);
  var free = remaining[key] === undefined ? r.awdAvailableUnits : remaining[key];
  var maxCases = Math.min(r.availableCases, casesIn(free, r.caseQty));

  if (d.cases > maxCases) {
    d.cases = clampMin0(maxCases);
    addNote(d, d.cases === 0 ? 'no AWD stock' : 'capped by AWD stock');
    addFlag(d, 'NEEDS_REVIEW');
  }
  remaining[key] = clampMin0(free - d.cases * r.caseQty);
  return d;
}

// --------------------------------------------------------------- LTF overlay

/**
 * §5 LTF overlay. The quantity stands — it is neither zeroed nor sent. The
 * comment from LTF column Q rides along so the decision is made with the note
 * in view.
 */
function applyLtf(d, r, ltfIndex) {
  if (!d || !ltfIndex) return d;
  var hit = ltfIndex[normSku(r.sku)];
  if (!hit) return d;
  d.ltfComment = hit.comment || '';
  addFlag(d, 'LTF_FLAG');
  addNote(d, 'LTF' + (hit.comment ? ': "' + hit.comment + '"' : '') + '. Review');
  return d;
}

// ========================================================================
// Rules_TacToAwd.gs
// ========================================================================

/**
 * Lane: Tactical -> AWD (§6).
 *
 * The demand-driven quantity is computed here. The Tactical floor is *not*
 * applied here: it binds the combined draw of this lane and Tactical>FBA
 * together (§8), so Allocate.gs enforces it once, with both numbers in hand.
 *
 * The pallet fill (§6.1) runs after that, because it may only spend Tactical
 * headroom that survived the floor.
 */

function planTacToAwd(rows, cfg, ltfIndex) {
  var R = cfg.RULES;
  var target = R.TAC_TO_AWD_TARGET_DOI;

  var out = rows.map(function (r) {
    if (isDiscontinued(r)) {
      return decision(0, 'discontinued — never Tactical > AWD', { pass: 'NONE' });
    }
    if (!(r.rate > 0)) {
      return decision(0, 'no order_plan_rate', { pass: 'NONE' });
    }
    if (r.caseQty <= 0) {
      return decision(0, 'no case size', { pass: 'NONE' });
    }
    if (r.availableCases <= 0) {
      return decision(0, 'no stock at Tactical', { pass: 'NONE' });
    }

    // The entry filter: short at BOTH ends. Thin at AWD while FBA is
    // comfortable is not a reason to move a pallet — FBA is what AWD feeds,
    // and it can wait for a run where something is genuinely at risk.
    if (!(r.awdDoi < R.TAC_TO_AWD_GATE_AWD_DOI)) {
      return decision(0, 'AWD already ' + fmt(r.awdDoi) + ' DOI', { pass: 'NONE' });
    }
    if (r.fbaDoi !== null && r.fbaDoi !== undefined
        && !(r.fbaDoi < R.TAC_TO_AWD_GATE_FBA_DOI)) {
      return decision(0, 'no need — FBA healthy at ' + fmt(r.fbaDoi) + ' DOI',
        { pass: 'NONE' });
    }

    var want = clampMin0(roundUp((target - r.awdDoi) * r.rate / r.caseQty));
    if (want === 0) {
      return decision(0, 'AWD already ' + fmt(r.awdDoi) + ' DOI (target '
        + target + ')', { pass: 'NONE' });
    }

    var d = decision(want, 'top-up AWD to ' + target + ' DOI', { pass: 'PASS_3' });

    if (d.cases > r.availableCases) {
      d.cases = clampMin0(r.availableCases);
      addNote(d, 'capped by Tactical stock (' + r.availableCases + ' cases)');
      addFlag(d, 'NEEDS_REVIEW');
    }
    return d;
  });

  rows.forEach(function (r, i) { applyLtf(out[i], r, ltfIndex); });
  return out;
}

function isDiscontinued(r) {
  return String(r.lifecycle || '').trim().toLowerCase() === 'discontinued';
}

/**
 * Is this run worth raising at all?
 *
 * Asked before the pallet minimum, and answered on urgency rather than volume:
 * the pallet is a constraint on a shipment, not a reason to make one. A SKU
 * with 40 days of AWD cover and healthy FBA behind it can wait for a run where
 * something is genuinely thin.
 *
 * Returns { urgent, reasons, thinnest } — `reasons` names the SKUs that
 * justify the run, so the verdict can say why rather than just yes or no.
 */
function decideTacToAwdRun(rows, decisions, cfg) {
  var R = cfg.RULES;
  var demand = decisions.reduce(function (s, d) { return s + (d.cases > 0 ? d.cases : 0); }, 0);

  var contributors = [];
  rows.forEach(function (r, i) {
    if (decisions[i].cases > 0) {
      contributors.push({ sku: r.sku, cases: decisions[i].cases, awdDoi: r.awdDoi });
    }
  });
  contributors.sort(function (a, b) { return a.awdDoi - b.awdDoi; });

  if (demand === 0) {
    return { raise: false, demandCases: 0, why: 'nothing short at both AWD and FBA' };
  }

  // The pallet is the decider. Everything that qualifies is already genuinely
  // short at both ends, so there is no filler to reach for — if the qualifying
  // volume will not fill a pallet, the run waits for one where it does.
  if (demand < R.PALLET_MIN_CASES) {
    var why = 'only ' + demand + ' case' + (demand === 1 ? '' : 's')
      + ' qualify, short of the ' + R.PALLET_MIN_CASES + '-case pallet'
      + (contributors.length ? ' (thinnest ' + contributors[0].sku + ' at '
        + fmt(contributors[0].awdDoi) + ' DOI at AWD)' : '')
      + ' — wait for a run that fills one';

    rows.forEach(function (r, i) {
      if (decisions[i].cases <= 0) return;
      decisions[i] = decision(0, 'held for a later run', {
        pass: 'NONE',
        notes: ['would have sent ' + decisions[i].cases + ' cases; run totals '
          + demand + ' of ' + R.PALLET_MIN_CASES],
      });
    });
    return { raise: false, demandCases: demand, why: why, held: true };
  }

  return {
    raise: true,
    demandCases: demand,
    why: contributors.length + ' SKU' + (contributors.length === 1 ? '' : 's')
      + ' short at both ends — ' + contributors.slice(0, 3).map(function (u) {
        return u.sku + ' (' + fmt(u.awdDoi) + ' DOI at AWD)';
      }).join(', ') + (contributors.length > 3 ? ' and others' : ''),
  };
}

/**
 * §6.1 — Tactical>AWD ships palletised, so a run that goes at all must carry
 * at least 25 cases.
 *
 * Filler is never surplus stock: it is volume that would have shipped on a
 * later run, pulled forward. So the pool is SKUs the ladder already scored 0 —
 * those sitting above the AWD target — taken closest-to-needing-it first, and
 * each filler case is tagged so it reads differently from demand.
 *
 *   headroomUnits  Tactical units per SKU still drawable after the floor and
 *                  after both lanes' demand has been served.
 *
 * Returns a summary for the run header; mutates `decisions` in place.
 */
function applyPalletFill(rows, decisions, cfg, headroomUnits, ltfIndex) {
  var R = cfg.RULES;
  var demand = decisions.reduce(function (s, d) { return s + d.cases; }, 0);

  var result = {
    demandCases: demand,
    target: R.PALLET_MIN_CASES,
    filledCases: 0,
    shortfall: 0,
    skipped: false,
  };

  // Nothing wants to move: don't build a pallet out of pure filler.
  if (demand === 0) {
    result.skipped = true;
    return result;
  }
  if (demand >= R.PALLET_MIN_CASES) return result;

  var pool = [];
  rows.forEach(function (r, i) {
    if (decisions[i].cases !== 0) return;          // demand-driven already
    if (isDiscontinued(r)) return;
    if (!(r.rate > 0)) return;
    if (!(r.awdDoi > dssFor(cfg, 'TAC_TO_AWD'))) return;
    if (r.caseQty <= 0) return;
    pool.push(i);
  });

  // Closest to needing replenishment first.
  pool.sort(function (a, b) { return rows[a].awdDoi - rows[b].awdDoi; });

  var added = {};
  var need = R.PALLET_MIN_CASES - demand;
  var progress = true;

  while (need > 0 && progress) {
    progress = false;
    for (var p = 0; p < pool.length && need > 0; p++) {
      var i = pool[p];
      var r = rows[i];
      var have = added[i] || 0;

      if (have >= R.PALLET_FILL_MAX_CASES_PER_SKU) continue;

      // The floor still has to hold with this case on the truck.
      var free = headroomUnits[normSku(r.sku)] || 0;
      if (free < r.caseQty) continue;

      // And the case must not spike AWD cover past the ceiling.
      var after = doi(r.awdQty + r.awdInbound14 + (have + 1) * r.caseQty, r.rate);
      if (after > R.PALLET_FILL_MAX_AWD_DOI) continue;

      added[i] = have + 1;
      headroomUnits[normSku(r.sku)] = free - r.caseQty;
      need--;
      result.filledCases++;
      progress = true;
    }
  }

  Object.keys(added).forEach(function (i) {
    var idx = Number(i);
    var r = rows[idx];
    var n = added[i];
    var after = doi(r.awdQty + r.awdInbound14 + n * r.caseQty, r.rate);
    decisions[idx] = decision(n, 'pallet fill, pulled forward from next run', {
      pass: 'PALLET_FILL',
      notes: ['AWD ' + fmt(r.awdDoi) + ' → ' + fmt(after) + ' DOI'],
    });
    applyLtf(decisions[idx], r, ltfIndex);
  });

  result.shortfall = clampMin0(need);
  return result;
}

// ========================================================================
// Rules_TacToFba.gs
// ========================================================================

/**
 * Lane: Tactical -> FBA (§7).
 *
 * Strictly residual. This lane exists only for what AWD could not cover, and
 * every gate has to hold before a single case moves. The Tactical floor is the
 * one gate not enforced here — it binds both Tactical lanes together, so
 * Allocate.gs applies it (§8), using the breach permission this module sets.
 */

function planTacToFba(rows, cfg, ltfIndex, awdBySku, inbound14BySku) {
  var dss = dssFor(cfg, 'TAC_TO_FBA');
  var R = cfg.RULES;

  var out = rows.map(function (r) {
    if (!(r.rate > 0)) return decision(0, 'no order_plan_rate', { pass: 'NONE' });
    if (r.caseQty <= 0) return decision(0, 'no case size', { pass: 'NONE' });

    // ---- gate 1: AWD could not cover it, for want of AWD stock -----------
    var cover = awdCoverage(r, awdBySku);
    if (!cover.uncovered) {
      return decision(0, cover.why, { pass: 'NONE' });
    }

    // ---- gate 2: no AWD replenishment landing inside 14 days -------------
    var inbound = inbound14BySku[normSku(r.sku)] || 0;
    if (inbound > 0 && !R.TAC_TO_FBA_COUNTS_THIS_RUN_AS_INBOUND) {
      return decision(0, 'AWD replenishment of ' + fmt(inbound)
        + ' units arriving within 14 days', { pass: 'NONE' });
    }

    // ---- quantity --------------------------------------------------------
    var t = fbaTarget(r, dss, R);
    if (!t.unitFloor && !t.liquidating && r.amzDoi >= t.target) {
      return decision(0, 'already ' + fmt(r.amzDoi) + ' DOI (target '
        + t.target + ')', { pass: 'NONE' });
    }

    var cases;
    if (t.unitFloor) {
      // Fill to the unit floor, rounding up — 101-4001 went 55 -> 100 as 45
      // one-unit cases on 08-13.
      cases = clampMin0(roundUp((t.unitFloor - r.amzTotal) / r.caseQty));
      if (cases === 0) {
        return decision(0, 'already ' + fmt(r.amzTotal) + ' units at FBA (floor '
          + t.unitFloor + ')', { pass: 'NONE' });
      }
    } else if (t.minimumOnly || R.TAC_TO_FBA_QTY_MODE === 'single_case') {
      cases = 1;
    } else {
      cases = Math.max(1, Math.floor((t.target - r.amzDoi) * r.rate / r.caseQty));
    }

    // ---- gate 4: and it must not spike FBA cover -------------------------
    while (cases > 1 && resultingDoi(r, cases) > t.ceiling) cases--;

    if (resultingDoi(r, cases) > t.ceiling) {
      return decision(0, '1 case would reach ' + fmt(resultingDoi(r, cases))
        + ' DOI (>' + fmt(t.ceiling) + ')', { pass: 'NONE' });
    }

    var how = t.unitFloor
      ? 'to the ' + t.unitFloor + '-unit floor, '
      : (t.liquidating ? 'liquidating discontinued stock, to ' : 'to ');
    var d = decision(cases, 'residual after AWD, ' + cover.why, {
      pass: 'PASS_2',
      notes: ['no inbound within 14 days',
        how + fmt(resultingDoi(r, cases)) + ' DOI'],
    });

    // Stock cap.
    if (d.cases > r.availableCases) {
      d.cases = clampMin0(r.availableCases);
      addNote(d, d.cases === 0 ? 'no Tactical stock' : 'capped by Tactical stock');
      addFlag(d, 'NEEDS_REVIEW');
    }

    // ---- §7.1: the floor may be breached, but only here and only loudly --
    d.floorBreachAllowed = floorBreachQualifies(r, cover, cases, R);
    if (d.floorBreachAllowed) d.floorBreachNote = 'AWD empty, FBA under '
      + R.FLOOR_BREACH_MAX_FBA_DOI + ' DOI';

    return d;
  });

  rows.forEach(function (r, i) { applyLtf(out[i], r, ltfIndex); });
  return out;
}

/**
 * What this SKU is being topped up to, and how far a case may overshoot it.
 *
 * §7 phrases two of these as targets and the third as a cap: "normal -> 60",
 * "Critical or B2B -> 100", "Discontinued -> 100 DOI cap, never exceed". The
 * difference is load-bearing. A discontinued SKU is being run down, so there
 * is nothing to top it up *to* — 100 is the line it must not cross. Read as a
 * target it produces the opposite of the intent: on 08-10-26 it would have
 * pushed 205 units of a liquidating SKU into FBA against Marco's 12.
 *
 * So discontinued SKUs get the minimum viable quantity and a hard ceiling,
 * while the other two get a target with the usual single-case allowance.
 */
function fbaTarget(r, dss, R) {
  // A per-SKU unit floor beats every DOI rule — it exists precisely because
  // days-of-cover is the wrong measure for that line.
  var floorUnits = R.FBA_MIN_UNITS_BY_SKU[normSku(r.sku)]
    || R.FBA_MIN_UNITS_BY_SKU[String(r.sku).trim()];
  if (floorUnits > 0) {
    return { target: doi(floorUnits, r.rate), ceiling: doi(floorUnits, r.rate),
      minimumOnly: false, unitFloor: floorUnits };
  }
  if (isDiscontinued(r)) {
    // Liquidating: push stock down, aim under 50 days, never past 110.
    return { target: R.DISCONTINUED_AIM_FBA_DOI,
      ceiling: R.DISCONTINUED_MAX_FBA_DOI, minimumOnly: false,
      liquidating: true };
  }
  var target = (r.b2b || r.critical) ? R.PRIORITY_DOI : dss;
  return {
    target: target,
    ceiling: target * R.TAC_TO_FBA_SPIKE_MULTIPLIER,
    minimumOnly: false,
  };
}

function resultingDoi(r, cases) {
  return doi(r.amzTotal + cases * r.caseQty, r.rate);
}

/**
 * Gate 1. The lane is residual, so it only opens when the AWD>FBA lane wanted
 * to send more and ran out of AWD stock — or when the SKU has no AWD stock to
 * draw on at all.
 */
function awdCoverage(r, awdBySku) {
  var awd = awdBySku[normSku(r.sku)];

  if (awd) {
    if (awd.cappedByAwdStock && awd.shortfallCases > 0) {
      return {
        uncovered: true,
        why: 'AWD stock exhausted (' + awd.shortfallCases + ' cases short)',
        awdEmpty: awd.awdAvailableUnits <= 0,
      };
    }
    return {
      uncovered: false,
      why: awd.cases > 0
        ? 'AWD is covering it (' + awd.cases + ' cases on the AWD>FBA lane)'
        : 'AWD>FBA found no need',
      awdEmpty: awd.awdAvailableUnits <= 0,
    };
  }

  // Not on the AWD lane at all. Only residual if there is genuinely no AWD stock.
  if (r.awdAvailableUnits <= 0) {
    return { uncovered: true, why: 'no AWD stock for this SKU', awdEmpty: true };
  }
  return { uncovered: false, why: 'AWD holds ' + fmt(r.awdAvailableUnits)
    + ' units, not on the AWD>FBA lane', awdEmpty: false };
}

/**
 * §7.1 — breaching the Tactical floor is allowed only when AWD is empty, FBA
 * is genuinely thin, and the transfer puts it back to roughly the baseline.
 * Rare by construction, and flagged rather than applied quietly.
 */
function floorBreachQualifies(r, cover, cases, R) {
  if (!cover.awdEmpty) return false;
  if (!(r.amzDoi < R.FLOOR_BREACH_MAX_FBA_DOI)) return false;
  var after = resultingDoi(r, cases);
  var low = R.FLOOR_BREACH_RESTORE_DOI * (1 - R.FLOOR_BREACH_RESTORE_TOLERANCE);
  var high = R.FLOOR_BREACH_RESTORE_DOI * (1 + R.FLOOR_BREACH_RESTORE_TOLERANCE);
  return after >= low && after <= high;
}

// ========================================================================
// Allocate.gs
// ========================================================================

/**
 * Contention (§8) and the run pipeline.
 *
 * Two lanes draw on the same Tactical stock, and the floor applies to their
 * combined draw rather than to each separately — so the two numbers have to be
 * settled together, per SKU, in a defined order.
 *
 * planUsTransferOrders() is the whole decision layer and touches no sheet. It
 * takes read data in, gives written decisions out, which is what lets the
 * back-test replay a past run through exactly the code that would ship it.
 */

/**
 * Settle both Tactical lanes against one stock pool.
 *
 * Returns { headroomUnits } — Tactical units per SKU still drawable once both
 * lanes have taken their share, which is the budget the pallet fill spends.
 */
function allocateTactical(awdRows, awdDec, fbaRows, fbaDec, cfg) {
  var R = cfg.RULES;
  var bySku = {};

  function slot(sku) {
    var k = normSku(sku);
    if (!bySku[k]) {
      bySku[k] = { awd: [], fba: [], available: 0, minUnits: 0, fbaDoi: null,
        floorKnown: true };
    }
    return bySku[k];
  }

  function noteFloor(s, r) {
    // null means the floor could not be read, which is not the same as zero.
    if (r.minUnits === null || r.minUnits === undefined) s.floorKnown = false;
    else s.minUnits = Math.max(s.minUnits, r.minUnits);
  }

  awdRows.forEach(function (r, i) {
    var s = slot(r.sku);
    s.awd.push(i);
    s.available = Math.max(s.available, r.tacAvailableUnits);
    noteFloor(s, r);
    if (s.fbaDoi === null && r.fbaDoi !== undefined && r.fbaDoi !== null) s.fbaDoi = r.fbaDoi;
  });

  fbaRows.forEach(function (r, i) {
    var s = slot(r.sku);
    s.fba.push(i);
    s.available = Math.max(s.available, r.tacAvailableUnits);
    noteFloor(s, r);
    // The FBA lane's own AMZ_DOI is the authoritative figure for the 40 test.
    s.fbaDoi = r.amzDoi;
  });

  var headroomUnits = {};
  var floorUnknown = [];

  Object.keys(bySku).forEach(function (k) {
    var s = bySku[k];

    // Does any FBA-lane decision here carry the §7.1 breach permission?
    var breach = s.fba.some(function (i) {
      return fbaDec[i] && fbaDec[i].floorBreachAllowed && fbaDec[i].cases > 0;
    });

    // Above the floor is shared. The floor itself is a reserve that only
    // Tactical > FBA may dip into, and only on the §7.1 exception — that lane
    // ships SPD, so a small rescue quantity is cheap. Tactical > AWD is
    // palletised and may never breach the floor to make up a pallet.
    var floor = s.minUnits;
    var pool = clampMin0(s.available - floor);
    var reserve = breach ? floor : 0;

    if (!s.floorKnown) {
      // An unauthorised IMPORTRANGE leaves #REF! where the floor should be.
      // Drawing on a floor we cannot see is how Tactical gets emptied, so
      // this SKU does not move until someone can read it.
      floorUnknown.push(k);
      pool = 0;
      reserve = 0;
    }

    // §8: below 40 FBA DOI, FBA is served first; otherwise AWD is.
    var fbaFirst = s.fbaDoi !== null && s.fbaDoi < R.FBA_DOI_CONTENTION;
    var order = fbaFirst
      ? [{ rows: fbaRows, dec: fbaDec, idx: s.fba, other: 'Tactical>AWD' },
         { rows: awdRows, dec: awdDec, idx: s.awd, other: 'Tactical>FBA' }]
      : [{ rows: awdRows, dec: awdDec, idx: s.awd, other: 'Tactical>FBA' },
         { rows: fbaRows, dec: fbaDec, idx: s.fba, other: 'Tactical>AWD' }];

    order.forEach(function (lane, laneNo) {
      lane.idx.forEach(function (i) {
        var d = lane.dec[i];
        var r = lane.rows[i];
        if (!d || d.cases <= 0) return;

        var wanted = d.cases;
        var isFba = lane.rows === fbaRows;
        var budget = pool + (isFba ? reserve : 0);
        var affordable = casesIn(budget, r.caseQty);

        if (wanted > affordable) {
          d.cases = clampMin0(affordable);
          if (d.cases === 0 && !s.floorKnown) {
            d.rule = 'Tactical floor unreadable (#REF!) — not drawing on Tactical';
            d.notes = [];
            addFlag(d, 'NEEDS_REVIEW');
          } else if (d.cases === 0 && floor > 0) {
            d.rule = 'Tactical floor (min ' + fmt(floor) + ' units) reached';
            d.notes = [];
          } else if (laneNo === 1) {
            addNote(d, 'reduced from ' + wanted + ', ' + lane.other + ' served first');
            addFlag(d, 'NEEDS_REVIEW');
          } else {
            addNote(d, 'reduced from ' + wanted + ' by the Tactical floor (min '
              + fmt(floor) + ' units)');
            addFlag(d, 'NEEDS_REVIEW');
          }
        }

        var take = d.cases * r.caseQty;
        if (breach && isFba && take > pool) {
          addFlag(d, 'FLOOR_BREACH');
          addNote(d, 'floor breached by ' + fmt(take - pool) + ' units (SPD): '
            + (d.floorBreachNote || 'exception'));
        }

        // Spend the shared pool first, then the reserve — which only the FBA
        // lane was given a budget against.
        if (take <= pool) {
          pool -= take;
        } else {
          reserve = clampMin0(reserve - (take - pool));
          pool = 0;
        }
      });
    });

    headroomUnits[k] = pool;
  });

  return { headroomUnits: headroomUnits, floorUnknown: floorUnknown };
}

/**
 * The whole decision layer, in the order the rules require:
 *
 *   1. AWD>FBA, because Tactical>FBA is residual to it
 *   2. Tactical>FBA, which needs to know what AWD could not cover
 *   3. Tactical>AWD demand
 *   4. Tactical contention, settling 2 and 3 against one floor
 *   5. Pallet fill, which may only spend what survived step 4
 *
 * `input` comes from readPlanningInput(); nothing here reads a sheet.
 */
function planUsTransferOrders(input, cfg) {
  var ltf = input.ltfIndex || {};

  // 1 — AWD > FBA
  var awdFbaDec = planAwdToFba(input.awdToFba, cfg, ltf);

  var awdBySku = {};
  input.awdToFba.forEach(function (r, i) {
    awdBySku[normSku(r.sku)] = {
      cases: awdFbaDec[i].cases,
      cappedByAwdStock: !!awdFbaDec[i].cappedByAwdStock,
      shortfallCases: awdFbaDec[i].shortfallCases || 0,
      awdAvailableUnits: r.awdAvailableUnits,
    };
  });

  // AWD inbound within 14 days is only carried on the Tactical>AWD lane.
  var inbound14 = {};
  input.tacToAwd.forEach(function (r) {
    inbound14[normSku(r.sku)] = r.awdInbound14;
  });

  // 2 — Tactical > FBA
  var tacFbaDec = planTacToFba(input.tacToFba, cfg, ltf, awdBySku, inbound14);

  // 3 — Tactical > AWD demand
  var tacAwdDec = planTacToAwd(input.tacToAwd, cfg, ltf);

  // 4 — one floor, two lanes
  var alloc = allocateTactical(input.tacToAwd, tacAwdDec,
    input.tacToFba, tacFbaDec, cfg);

  // 4b — is this run worth raising?
  //
  // Asked *after* the floor, because the floor is most of the answer. Five of
  // the twelve SKUs that qualified on 08-13 could not give up a single case
  // without breaking their minimum at Tactical; counting them left 25 cases
  // and a pallet, counting what could actually move left 13 and a wait.
  var tacAwdVerdict = decideTacToAwdRun(input.tacToAwd, tacAwdDec, cfg);

  // 5 — the pallet minimum applies to a run that is going, and only then
  var pallet = tacAwdVerdict.raise
    ? applyPalletFill(input.tacToAwd, tacAwdDec, cfg, alloc.headroomUnits, ltf)
    : {
      demandCases: tacAwdVerdict.demandCases, target: cfg.RULES.PALLET_MIN_CASES,
      filledCases: 0, shortfall: 0, skipped: true,
    };

  return {
    tacToAwd: tacAwdDec,
    awdToFba: awdFbaDec,
    tacToFba: tacFbaDec,
    pallet: pallet,
    floorUnknown: alloc.floorUnknown,
    verdicts: {
      tacToAwd: withFloorWarning(
        laneVerdict('Tactical → AWD', input.tacToAwd, tacAwdDec, tacAwdVerdict),
        alloc.floorUnknown),
      awdToFba: laneVerdict('AWD → FBA', input.awdToFba, awdFbaDec, null),
      tacToFba: withFloorWarning(
        laneVerdict('Tactical → FBA', input.tacToFba, tacFbaDec, null),
        alloc.floorUnknown),
    },
    totals: {
      tacToAwdCases: sumCases(tacAwdDec),
      awdToFbaCases: sumCases(awdFbaDec),
      tacToFbaCases: sumCases(tacFbaDec),
      ltfHeld: countFlag(awdFbaDec, 'LTF_FLAG') + countFlag(tacAwdDec, 'LTF_FLAG')
        + countFlag(tacFbaDec, 'LTF_FLAG'),
      needsReview: countFlag(awdFbaDec, 'NEEDS_REVIEW')
        + countFlag(tacAwdDec, 'NEEDS_REVIEW') + countFlag(tacFbaDec, 'NEEDS_REVIEW'),
      floorBreaches: countFlag(tacFbaDec, 'FLOOR_BREACH'),
    },
  };
}

/**
 * Raise this transfer order, or not — and why, in one line.
 *
 * The answer to "should I do this TO today" should not require reading 491
 * rows to work out, so each lane states it plainly. `pre` carries a verdict
 * already reached by the lane's own rules (Tactical > AWD decides on urgency
 * before volume); the others are simply whether anything survived.
 */
function laneVerdict(label, rows, decisions, pre) {
  var cases = sumCases(decisions);
  var skus = decisions.reduce(function (s, d) {
    return s + (d && d.cases > 0 ? 1 : 0);
  }, 0);

  if (pre && !pre.raise) {
    return { lane: label, raise: false, cases: 0, skus: 0, why: pre.why };
  }
  if (cases === 0) {
    return {
      lane: label, raise: false, cases: 0, skus: 0,
      why: label === 'Tactical → FBA'
        ? 'AWD is covering every shortfall — nothing residual to send'
        : 'nothing below target',
    };
  }
  return {
    lane: label, raise: true, cases: cases, skus: skus,
    why: skus + ' SKU' + (skus === 1 ? '' : 's') + ', ' + cases + ' cases'
      + (pre && pre.why ? ' — ' + pre.why : ''),
  };
}

/**
 * A floor nobody could read is not a floor of zero, and a run that drew on one
 * is not a run you want to discover afterwards. Say it on the verdict.
 */
function withFloorWarning(verdict, floorUnknown) {
  if (!floorUnknown || !floorUnknown.length) return verdict;
  verdict.floorUnknown = floorUnknown.length;
  verdict.why = '⚠ Tactical floor unreadable for ' + floorUnknown.length
    + ' SKU' + (floorUnknown.length === 1 ? '' : 's') + ' ('
    + floorUnknown.slice(0, 3).join(', ')
    + (floorUnknown.length > 3 ? '…' : '') + ') — those are held. '
    + 'Run Transfer Orders → Authorise data sources, then run again. ' + verdict.why;
  return verdict;
}

function sumCases(dec) {
  return dec.reduce(function (s, d) { return s + (d && d.cases > 0 ? d.cases : 0); }, 0);
}

function countFlag(dec, flag) {
  return dec.reduce(function (s, d) {
    return s + (d && d.flags && d.flags.indexOf(flag) !== -1 ? 1 : 0);
  }, 0);
}

// ========================================================================
// Read.gs
// ========================================================================

/**
 * Pulls every input the rules need into one plain object per lane.
 *
 * Two habits here are deliberate:
 *
 *  - Tabs are resolved tolerantly (trimmed, case-insensitive). One of the real
 *    tab names ends in a space; a lookup that depends on reproducing that
 *    exactly is a trap, and the failure it produces ("no such sheet") tells you
 *    nothing. On a miss the error lists the tabs that do exist.
 *
 *  - Critical and B2B come from their own tabs, not from the MATCH formulas
 *    sitting in the lane columns, so a stale or broken formula cannot quietly
 *    change a decision.
 */

/** Find a sheet by name, ignoring case and surrounding space. */
function sheetByName(ss, name) {
  if (!name) return null;
  var want = String(name).trim().toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === want) return sheets[i];
  }
  return null;
}

function requireSheet(ss, name, what) {
  var sh = sheetByName(ss, name);
  if (sh) return sh;
  var have = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; });
  throw new Error('Cannot find the ' + what + ' tab "' + name + '" in "'
    + ss.getName() + '".\n  Tabs present: ' + have.join(', '));
}

/** Values from `firstRow` to the last row with content, or [] if none. */
function readBlock(sheet, firstRow) {
  var last = sheet.getLastRow();
  if (last < firstRow) return [];
  var width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(firstRow, 1, last - firstRow + 1, width).getValues();
}

/**
 * A fresh copy's IMPORTRANGE/QUERY cells return "Loading..." for a moment, and
 * a script that reads through that writes decisions built on nothing. Wait for
 * the lane tabs to settle, and say so plainly if they never do.
 */
function waitForFormulas(ss, tabNames, timeoutSeconds) {
  var deadline = Date.now() + (timeoutSeconds || 120) * 1000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    var loading = false;
    for (var i = 0; i < tabNames.length && !loading; i++) {
      var sh = sheetByName(ss, tabNames[i]);
      if (!sh) continue;
      var vals = readBlock(sh, 1);
      for (var r = 0; r < vals.length && !loading; r++) {
        for (var c = 0; c < vals[r].length; c++) {
          if (vals[r][c] === 'Loading...') { loading = true; break; }
        }
      }
    }
    if (!loading) return true;
    Utilities.sleep(2000);
  }
  throw new Error('Lane tabs still showed "Loading..." after '
    + (timeoutSeconds || 120) + 's. The IMPORTRANGE feeding this planner has not '
    + 'settled — open the file, confirm access, and run again.');
}

// ------------------------------------------------------------- lookup tables

/** SKU -> { comment } for everything on the LTF tab in this market. */
function readLtf(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.LTF);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.LTF;
  readBlock(sh, cfg.LAYOUT.LTF_HEADER_ROW + 1).forEach(function (row) {
    var sku = normSku(row[C.SKU]);
    if (!sku) return;
    var market = String(row[C.MARKET] || '').trim().toUpperCase();
    if (market && market !== cfg.MARKET) return;
    out[sku] = { comment: String(row[C.COMMENT] || '').trim() };
  });
  return out;
}

/** The set of SKUs on the CRITICAL tab. */
function readCritical(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.CRITICAL);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.CRITICAL;
  readBlock(sh, cfg.LAYOUT.CRITICAL_HEADER_ROW + 1).forEach(function (row) {
    var sku = normSku(row[C.SKU]);
    if (sku) out[sku] = true;
  });
  return out;
}

/** name -> { amazonSku, caseQty, discontinued } from `Copy of Sheet1`. */
function readProducts(ss, cfg) {
  var sh = sheetByName(ss, cfg.TABS.PRODUCTS);
  var out = {};
  if (!sh) return out;
  var C = cfg.COLS.PRODUCTS;
  readBlock(sh, cfg.LAYOUT.PRODUCTS_HEADER_ROW + 1).forEach(function (row) {
    var name = normSku(row[C.NAME]);
    if (!name) return;
    out[name] = {
      amazonSku: String(row[C.AMAZON_SKU] || '').trim(),
      caseQty: num(row[C.CASE_QTY]),
      discontinued: String(row[C.DISCONTINUED] || '').trim().toUpperCase() === 'T',
    };
  });
  return out;
}

/**
 * The Tactical floor, read straight from its own workbook (§2).
 *
 * Returns { bySku, source }. When the tab is not configured or not readable the
 * caller falls back to the planner's own column B — which is the same number by
 * a longer route, but the run header has to say which was used.
 */
function readMinUnits(cfg) {
  var conf = cfg.MIN_UNITS;
  var missing = function (why) {
    return { bySku: {}, b2bSkus: {}, count: 0, source: 'planner column B (' + why + ')' };
  };
  if (!conf.TAB) return missing('MIN_UNITS.TAB not set');

  try {
    var ss = SpreadsheetApp.openById(cfg.SOURCES.MIN_UNITS_ID);
    var sh = requireSheet(ss, conf.TAB, 'minimum units');
    var all = readBlock(sh, 1);
    if (!all.length) throw new Error('tab is empty');

    // The planner reaches this data with VLOOKUP over A:E, which neither knows
    // nor cares whether row 1 is a header. Match that: only skip the first row
    // when it really does carry both header labels, so a tab with no header
    // does not quietly lose its first SKU.
    var header = all[0].map(function (h) {
      return String(h || '').trim().toLowerCase();
    });
    var skuCol = header.indexOf(String(conf.SKU_HEADER).toLowerCase());
    var unitsCol = header.indexOf(String(conf.UNITS_HEADER).toLowerCase());
    var labelled = skuCol !== -1 && unitsCol !== -1;
    if (!labelled) {
      skuCol = conf.SKU_COL;
      unitsCol = conf.UNITS_COL;
    }

    var bySku = {};
    var b2bSkus = {};
    var count = 0;
    (labelled ? all.slice(1) : all).forEach(function (row) {
      var sku = normSku(row[skuCol]);
      if (!sku) return;
      bySku[sku] = num(row[unitsCol]);
      b2bSkus[sku] = true;
      if (bySku[sku] > 0) count++;
    });

    return {
      bySku: bySku,
      b2bSkus: conf.TREAT_AS_B2B ? b2bSkus : {},
      count: count,
      source: ss.getName() + ' / ' + sh.getName() + ' — ' + count + ' floors',
    };
  } catch (e) {
    return missing('direct read failed: ' + e.message);
  }
}

// -------------------------------------------------------------------- lanes

function laneRows(ss, tabName, cfg, what) {
  var sh = requireSheet(ss, tabName, what);
  return {
    sheet: sh,
    values: readBlock(sh, cfg.LAYOUT.LANE_FIRST_DATA_ROW),
    firstRow: cfg.LAYOUT.LANE_FIRST_DATA_ROW,
  };
}

/** Rows with a name, in this market. Blank names end the lane. */
function usable(values, nameCol, mktCol, cfg) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var name = String(row[nameCol] || '').trim();
    if (!name) continue;
    var mkt = String(row[mktCol] || '').trim().toUpperCase();
    if (mkt && mkt !== cfg.MARKET) continue;
    out.push({ row: row, offset: i });
  }
  return out;
}

/**
 * Every input the decision layer needs, for one planner.
 *
 * `planner` is the workbook being written. When SOURCES.LANES_FROM is 'ims'
 * the lane values are taken from the IMS instead — same layout, same reader.
 */
function readPlanningInput(planner, cfg) {
  var ims = null;
  try {
    ims = SpreadsheetApp.openById(cfg.SOURCES.IMS_ID);
  } catch (e) {
    ims = null; // Not fatal: only the optional B2B tab lives there.
  }

  var laneSource = planner;
  var tabs = cfg.TABS;
  if (cfg.SOURCES.LANES_FROM === 'ims') {
    if (!ims) throw new Error('LANES_FROM is "ims" but the IMS could not be opened.');
    var t = cfg.SOURCES.IMS_LANE_TABS;
    if (!t.TAC_TO_AWD || !t.AWD_TO_FBA || !t.TAC_TO_FBA) {
      throw new Error('LANES_FROM is "ims" but SOURCES.IMS_LANE_TABS is not filled in.');
    }
    laneSource = ims;
    tabs = {
      TAC_TO_AWD: t.TAC_TO_AWD,
      AWD_TO_FBA: t.AWD_TO_FBA,
      TAC_TO_FBA: t.TAC_TO_FBA,
    };
  }

  waitForFormulas(laneSource,
    [tabs.TAC_TO_AWD, tabs.AWD_TO_FBA, tabs.TAC_TO_FBA], 120);

  var critical = readCritical(planner, cfg);
  var ltfIndex = readLtf(planner, cfg);
  var products = readProducts(planner, cfg);

  // The B2B tab and the Tactical floor are the same tab: the planner's column
  // B is VLOOKUP(name, 'B2B'!A:E, 5). One read serves both.
  var minUnits = readMinUnits(cfg);
  var b2bTab = minUnits.b2bSkus;

  function caseQtyFor(sku, cellValue) {
    var q = num(cellValue);
    if (q > 0) return q;
    var p = products[normSku(sku)];
    return p ? p.caseQty : 0;
  }

  /**
   * The Tactical floor, or null when it genuinely cannot be read.
   *
   * Never zero on failure. An unauthorised IMPORTRANGE leaves #REF! in column
   * B, and reading that as "no floor" is the one direction that empties
   * Tactical — it is what let a real run draw five SKUs down to zero units
   * against floors of 100. Unknown has to stay unknown so the lane can refuse
   * to draw rather than quietly overdraw.
   */
  var floorUnknown = [];
  function floorFor(sku, cellValue) {
    var k = normSku(sku);
    if (Object.prototype.hasOwnProperty.call(minUnits.bySku, k)) return minUnits.bySku[k];
    if (isSheetError(cellValue)) {
      floorUnknown.push(sku);
      return null;
    }
    return num(cellValue);
  }

  function isB2b(sku, cellValue) {
    return bool(cellValue) || !!b2bTab[normSku(sku)];
  }

  // ---- Tactical > AWD ----------------------------------------------------
  var A = cfg.COLS.TAC_TO_AWD;
  var aLane = laneRows(laneSource, tabs.TAC_TO_AWD, cfg, 'Tactical > AWD');
  var tacToAwd = usable(aLane.values, A.NAME, A.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[A.NAME]).trim();
    return {
      rowIndex: aLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[A.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[A.ORDER_PLAN_RATE]),
      trueRate30: num(row[A.TRUE_RATE_30]),
      lifecycle: String(row[A.LIFECYCLE] || '').trim(),
      tacAvailableUnits: num(row[A.TAC_AVAILABLE]),
      availableCases: num(row[A.AVAILABLE_CASES]),
      wrDoi: num(row[A.WR_DOI]),
      awdQty: num(row[A.AWD_QTY]),
      awdInbound14: num(row[A.AWD_INBOUND_14]),
      awdDoi: num(row[A.AWD_DOI]),
      caseQty: caseQtyFor(sku, row[A.CASE_QTY]),
      minUnits: floorFor(sku, row[A.MIN_UNITS]),
      fbaDoi: num(row[A.FBA_DOI], null),
    };
  });

  // ---- AWD > FBA ---------------------------------------------------------
  var F = cfg.COLS.AWD_TO_FBA;
  var fLane = laneRows(laneSource, tabs.AWD_TO_FBA, cfg, 'AWD > FBA');
  var awdToFba = usable(fLane.values, F.NAME, F.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[F.NAME]).trim();
    return {
      rowIndex: fLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[F.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[F.ORDER_PLAN_RATE]),
      trueRate30: num(row[F.TRUE_RATE_30]),
      lifecycle: String(row[F.LIFECYCLE] || '').trim(),
      awdAvailableUnits: num(row[F.AWD_AVAILABLE]),
      availableCases: num(row[F.AVAILABLE_CASES]),
      awdDoi: num(row[F.AWD_DOI]),
      amzFulfillable: num(row[F.AMZ_FULFILLABLE]),
      amzReserved: num(row[F.AMZ_RESERVED]),
      amzInbound: num(row[F.AMZ_INBOUND]),
      amzTotal: num(row[F.AMZ_TOTAL]),
      amzDoi: num(row[F.AMZ_DOI]),
      caseQty: caseQtyFor(sku, row[F.CASE_QTY]),
    };
  });

  // ---- Tactical > FBA ----------------------------------------------------
  var T = cfg.COLS.TAC_TO_FBA;
  var tLane = laneRows(laneSource, tabs.TAC_TO_FBA, cfg, 'Tactical > FBA');
  var tacToFba = usable(tLane.values, T.NAME, T.MKT, cfg).map(function (u) {
    var row = u.row;
    var sku = String(row[T.NAME]).trim();
    return {
      rowIndex: tLane.firstRow + u.offset,
      sku: sku,
      b2b: isB2b(sku, row[T.B2B]),
      critical: !!critical[normSku(sku)],
      rate: num(row[T.ORDER_PLAN_RATE]),
      trueRate30: num(row[T.TRUE_RATE_30]),
      lifecycle: String(row[T.LIFECYCLE] || '').trim(),
      tacAvailableUnits: num(row[T.TAC_AVAILABLE]),
      availableCases: num(row[T.AVAILABLE_CASES]),
      tacDoi: num(row[T.TAC_DOI]),
      amzFulfillable: num(row[T.AMZ_FULFILLABLE]),
      amzReserved: num(row[T.AMZ_RESERVED]),
      amzInbound: num(row[T.AMZ_INBOUND]),
      amzTotal: num(row[T.AMZ_TOTAL]),
      amzDoi: num(row[T.AMZ_DOI]),
      caseQty: caseQtyFor(sku, row[T.CASE_QTY]),
      minUnits: floorFor(sku, row[T.MIN_UNITS]),
      awdAvailableUnits: num(row[T.AWD_AVAILABLE]),
    };
  });

  return {
    tacToAwd: tacToAwd,
    awdToFba: awdToFba,
    tacToFba: tacToFba,
    ltfIndex: ltfIndex,
    criticalIndex: critical,
    products: products,
    sheets: {
      tacToAwd: sheetByName(planner, cfg.TABS.TAC_TO_AWD),
      awdToFba: sheetByName(planner, cfg.TABS.AWD_TO_FBA),
      tacToFba: sheetByName(planner, cfg.TABS.TAC_TO_FBA),
    },
    meta: {
      minUnitsSource: minUnits.source,
      floorUnknown: floorUnknown,
      laneSource: cfg.SOURCES.LANES_FROM === 'ims' ? 'IMS' : 'planner',
      criticalCount: Object.keys(critical).length,
      ltfCount: Object.keys(ltfIndex).length,
      productCount: Object.keys(products).length,
    },
  };
}

// ========================================================================
// Write.gs
// ========================================================================

/**
 * Everything that lands in the sheet: quantities, reason codes, colours, the
 * summary tabs, the CSV tabs and the run header.
 *
 * The units column is written as a formula (=N8*O8) rather than a number. When
 * Marco overrides a case count — which is the point of proposing rather than
 * deciding — the units follow him instead of silently disagreeing.
 */

function writePlan(planner, input, plan, cfg, ctx) {
  writeLane(input.sheets.tacToAwd, input.tacToAwd, plan.tacToAwd,
    cfg.COLS.TAC_TO_AWD, cfg, 'Reason');
  writeLane(input.sheets.awdToFba, input.awdToFba, plan.awdToFba,
    cfg.COLS.AWD_TO_FBA, cfg, 'Reason');
  writeLane(input.sheets.tacToFba, input.tacToFba, plan.tacToFba,
    cfg.COLS.TAC_TO_FBA, cfg, 'Reason');

  tintLaneUrgency(input.sheets.tacToAwd, input.tacToAwd, cfg.COLS.TAC_TO_AWD.AWD_DOI, cfg);
  tintLaneUrgency(input.sheets.awdToFba, input.awdToFba, cfg.COLS.AWD_TO_FBA.AMZ_DOI, cfg);
  tintLaneUrgency(input.sheets.tacToFba, input.tacToFba, cfg.COLS.TAC_TO_FBA.AMZ_DOI, cfg);

  if (cfg.OUTPUT.WRITE_RECOMPUTED_Y) {
    writeAvailableOnlyDoi(input.sheets.awdToFba, input.awdToFba, cfg);
  }
  if (cfg.OUTPUT.WRITE_SUMMARIES) {
    writeSummaries(planner, input, plan, cfg);
  }
  if (cfg.OUTPUT.WRITE_CSV_TABS) {
    writeCsvTabs(planner, input, plan, cfg);
  }
  writeRunHeader(planner, input, plan, cfg, ctx);
}

// --------------------------------------------------------------------- lanes

/**
 * The reason column is one past the lane's last used column, which on
 * Tactical > FBA is column Y — one beyond the 24 the tab actually has. Asking
 * for a range outside the grid throws, so widen the sheet first.
 */
function ensureColumns(sheet, count) {
  var have = sheet.getMaxColumns();
  if (have < count) sheet.insertColumnsAfter(have, count - have);
}

function writeLane(sheet, rows, decisions, C, cfg, reasonHeader) {
  if (!sheet || !rows.length) return;
  ensureColumns(sheet, C.REASON + 1);

  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var last = rows[rows.length - 1].rowIndex;
  var span = last - first + 1;

  var cases = blankColumn(span);
  var units = blankColumn(span);
  var reason = blankColumn(span);
  var fills = blankColumn(span, null);

  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d) return;
    var at = r.rowIndex - first;
    var qty = d.cases > 0 ? d.cases : 0;

    cases[at][0] = qty;
    units[at][0] = '=' + colLetter(C.CASES_OUT) + r.rowIndex
      + '*' + colLetter(C.CASE_QTY) + r.rowIndex;
    reason[at][0] = reasonText(d, r.caseQty);
    fills[at][0] = colourFor(d, cfg);
  });

  sheet.getRange(first, C.CASES_OUT + 1, span, 1).setValues(cases);
  sheet.getRange(first, C.UNITS_OUT + 1, span, 1).setFormulas(units);

  var reasonRange = sheet.getRange(first, C.REASON + 1, span, 1);
  reasonRange.setValues(reason);
  reasonRange.setBackgrounds(fills);
  sheet.getRange(first, C.CASES_OUT + 1, span, 1).setBackgrounds(fills);

  var head = sheet.getRange(cfg.LAYOUT.LANE_HEADER_ROW, C.REASON + 1);
  head.setValue(reasonHeader);
  head.setBackground(cfg.COLOURS.HEADER);
  head.setFontWeight('bold');

  // A floor breach is rare enough to deserve something you cannot scroll past.
  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d || d.flags.indexOf('FLOOR_BREACH') === -1) return;
    sheet.getRange(r.rowIndex, C.CASES_OUT + 1, 1, 2)
      .setBorder(true, true, true, true, false, false,
        cfg.COLOURS.FLOOR_BREACH_BORDER, SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
}

/**
 * Ramp the destination-DOI column red to green, so scanning the lane shows
 * what is close to running out before you read a single number.
 */
function tintLaneUrgency(sheet, rows, doiCol, cfg) {
  if (!sheet || !rows.length) return;
  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var span = rows[rows.length - 1].rowIndex - first + 1;
  var fills = blankColumn(span, null);
  rows.forEach(function (r) {
    fills[r.rowIndex - first][0] = urgencyColour(urgencyOf(r), cfg);
  });
  sheet.getRange(first, doiCol + 1, span, 1).setBackgrounds(fills);
}

/** §4 — column Y recomputed on order_plan_rate, so the sheet shows what the rule used. */
function writeAvailableOnlyDoi(sheet, rows, cfg) {
  if (!sheet || !rows.length) return;
  var C = cfg.COLS.AWD_TO_FBA;
  var first = cfg.LAYOUT.LANE_FIRST_DATA_ROW;
  var span = rows[rows.length - 1].rowIndex - first + 1;
  var col = blankColumn(span);
  rows.forEach(function (r) {
    col[r.rowIndex - first][0] = r.rate > 0 ? r.amzFulfillable / r.rate : '';
  });
  sheet.getRange(first, C.AVAILABLE_ONLY_DOI + 1, span, 1).setValues(col);
}

function colourFor(d, cfg) {
  if (d.flags.indexOf('LTF_FLAG') !== -1) return cfg.COLOURS.LTF;
  if (d.flags.indexOf('NEEDS_REVIEW') !== -1) return cfg.COLOURS.NEEDS_REVIEW;
  if (d.pass === 'PALLET_FILL') return cfg.COLOURS.PALLET_FILL;
  if (d.pass === 'PASS_1') return cfg.COLOURS.PASS_1;
  if (d.pass === 'PASS_2') return cfg.COLOURS.PASS_2;
  return cfg.COLOURS.PASS_3;
}

function blankColumn(n, value) {
  var v = value === undefined ? '' : value;
  var out = [];
  for (var i = 0; i < n; i++) out.push([v]);
  return out;
}

function colLetter(zeroBased) {
  var s = '';
  var i = zeroBased + 1;
  while (i > 0) {
    var r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// ----------------------------------------------------------------- summaries

/**
 * Days of cover at the destination — the number that decides how urgent a row
 * is. FBA for the two lanes that end there, AWD for Tactical > AWD.
 */
function urgencyOf(row) {
  if (row.amzDoi !== undefined && row.amzDoi !== null) return row.amzDoi;
  if (row.awdDoi !== undefined && row.awdDoi !== null) return row.awdDoi;
  return 999999;
}

/** The first band the cover falls into. */
function urgencyColour(doi, cfg) {
  var bands = cfg.URGENCY.BANDS;
  for (var i = 0; i < bands.length; i++) {
    if (doi <= bands[i].upTo) return bands[i].colour;
  }
  return bands[bands.length - 1].colour;
}

/**
 * Accepted rows for a lane: cases > 0, most urgent first.
 *
 * Sorted on days of cover rather than SKU, because the question when reading
 * down a pick list is "what runs out first", and alphabetical order answers a
 * question nobody asked.
 */
function accepted(rows, decisions, cfg) {
  var out = [];
  rows.forEach(function (r, i) {
    var d = decisions[i];
    if (!d || d.cases <= 0) return;
    if (!cfg.OUTPUT.LTF_IN_SUMMARIES && d.flags.indexOf('LTF_FLAG') !== -1) return;
    out.push({ row: r, dec: d, urgency: urgencyOf(r) });
  });
  out.sort(function (a, b) {
    if (cfg.URGENCY.SORT_BY_URGENCY && a.urgency !== b.urgency) {
      return a.urgency - b.urgency;
    }
    return a.row.sku < b.row.sku ? -1 : (a.row.sku > b.row.sku ? 1 : 0);
  });
  return out;
}

function amazonSkuFor(input, sku) {
  var p = input.products[normSku(sku)];
  return p ? p.amazonSku : '';
}

/** Paint each written summary row by how close it is to running out. */
function tintByUrgency(sheet, headerRow, picks, width, cfg) {
  if (!sheet || !picks.length || !cfg.URGENCY.TINT_SUMMARIES) return;
  var fills = picks.map(function (p) {
    var c = urgencyColour(p.urgency, cfg);
    var row = [];
    for (var i = 0; i < width; i++) row.push(c);
    return row;
  });
  sheet.getRange(headerRow + 1, 1, picks.length, width).setBackgrounds(fills);
}

/** Replace everything below the header row, so nothing survives from last week. */
function replaceBelowHeader(sheet, headerRow, rows, width) {
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last > headerRow) {
    // Formats as well as content: an urgency tint left on a row that no longer
    // has a SKU in it reads as a live, urgent line.
    var stale = sheet.getRange(headerRow + 1, 1, last - headerRow,
      Math.max(sheet.getLastColumn(), width));
    stale.clearContent();
    stale.setBackground(null);
  }
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, width).setValues(rows);
  }
}

function writeSummaries(planner, input, plan, cfg) {
  var H = cfg.LAYOUT.SUMMARY_HEADER_ROW;

  // Tactical > AWD: name | Case QTY | units | Amazon SKU | Cases | LTF
  var a = accepted(input.tacToAwd, plan.tacToAwd, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      amazonSkuFor(input, x.row.sku), x.dec.cases, x.dec.ltfComment || ''];
  });
  var aSheet = sheetByName(planner, cfg.TABS.SUMMARY_TAC_AWD);
  replaceBelowHeader(aSheet, H, a, 6);
  tintByUrgency(aSheet, H, accepted(input.tacToAwd, plan.tacToAwd, cfg), 6, cfg);

  // AWD > FBA: SKU | Case qty | Units | CASES | LTF.
  // This one is typed straight into Seller Central, so it stays this narrow.
  var f = accepted(input.awdToFba, plan.awdToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      x.dec.cases, x.dec.ltfComment || ''];
  });
  var fSheet = sheetByName(planner, cfg.TABS.SUMMARY_AWD_FBA);
  replaceBelowHeader(fSheet, H, f, 5);
  tintByUrgency(fSheet, H, accepted(input.awdToFba, plan.awdToFba, cfg), 5, cfg);

  // Tactical > FBA: name | Case QTY | units | Amazon SKU | Cases
  var t = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return [x.row.sku, x.row.caseQty, x.dec.cases * x.row.caseQty,
      amazonSkuFor(input, x.row.sku), x.dec.cases];
  });
  var tSheet = sheetByName(planner, cfg.TABS.SUMMARY_TAC_FBA);
  replaceBelowHeader(tSheet, H, t, 5);
  tintByUrgency(tSheet, H, accepted(input.tacToFba, plan.tacToFba, cfg), 5, cfg);
}

// ----------------------------------------------------------------- CSV tabs

/**
 * externalid and FBA_iD stay blank: the TO number and the shipment ID do not
 * exist until the transfer has been raised, and are pasted in afterwards.
 */
function writeCsvTabs(planner, input, plan, cfg) {
  var H = cfg.LAYOUT.CSV_HEADER_ROW;

  // The trandate is what tells a later reader whether these rows belong to
  // this run or were carried in with the file — a CSV tab dated to another
  // day means nothing shipped from Tactical that week. So it is stamped with
  // the planner's own date, not with today's.
  var stamp = plannerDate(planner.getName()) || new Date();

  var awd = accepted(input.tacToAwd, plan.tacToAwd, cfg).map(function (x) {
    return ['', stamp, cfg.OUTPUT.SHIP_METHOD_TAC_AWD, x.row.sku,
      x.dec.cases * x.row.caseQty, ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TAC_AWD), H, awd, 6);

  var fba = accepted(input.tacToFba, plan.tacToFba, cfg).map(function (x) {
    return ['', stamp, cfg.OUTPUT.SHIP_METHOD_TAC_FBA, x.row.sku,
      x.dec.cases * x.row.caseQty, ''];
  });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TAC_FBA), H, fba, 6);

  // CSV to Tactical is the pick instruction, so CartonToAmazon is the whole
  // draw on Tactical this run — both lanes, not just the AWD one.
  var fbaCasesBySku = {};
  input.tacToFba.forEach(function (r, i) {
    var d = plan.tacToFba[i];
    if (d && d.cases > 0) {
      fbaCasesBySku[normSku(r.sku)] = (fbaCasesBySku[normSku(r.sku)] || 0) + d.cases;
    }
  });

  var tactical = [];
  input.tacToAwd.forEach(function (r, i) {
    var d = plan.tacToAwd[i];
    var toAmazon = (d && d.cases > 0 ? d.cases : 0)
      + (fbaCasesBySku[normSku(r.sku)] || 0);
    if (r.tacAvailableUnits <= 0 && toAmazon === 0) return;
    tactical.push([r.sku, r.availableCases, r.tacAvailableUnits, toAmazon]);
  });
  tactical.sort(function (x, y) { return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0); });
  replaceBelowHeader(sheetByName(planner, cfg.TABS.CSV_TO_TACTICAL), H, tactical, 4);
}

// --------------------------------------------------------------- run header

/** What was run, against what, with which dials — on its own tab. */
function writeRunHeader(planner, input, plan, cfg, ctx) {
  var name = cfg.TABS.RUN_HEADER;
  var sh = sheetByName(planner, name);
  if (!sh) sh = planner.insertSheet(name);
  sh.clear();

  var c = ctx || {};
  var pallet = plan.pallet;
  var v = plan.verdicts;

  // The verdict goes first. "Do I raise this TO today, and why" is the whole
  // question, and it should not need 491 rows of reading to answer.
  var lines = [
    ['US transfer order plan', ''],
    ['', ''],
    ['RAISE THIS ORDER?', ''],
    [v.tacToAwd.lane, (v.tacToAwd.raise ? 'YES — ' : 'NO — ') + v.tacToAwd.why],
    [v.awdToFba.lane, (v.awdToFba.raise ? 'YES — ' : 'NO — ') + v.awdToFba.why],
    [v.tacToFba.lane, (v.tacToFba.raise ? 'YES — ' : 'NO — ') + v.tacToFba.why],
    ['', ''],
    ['Built', Utilities.formatDate(new Date(), cfg.TIMEZONE, 'yyyy-MM-dd HH:mm z')],
    ['Snapshot', c.snapshot || 'live'],
    ['Lane values from', input.meta.laneSource],
    ['Tactical floor from', input.meta.minUnitsSource],
    ['', ''],
    ['DSS — Tactical > AWD', dssFor(cfg, 'TAC_TO_AWD')],
    ['DSS — AWD > FBA', dssFor(cfg, 'AWD_TO_FBA')],
    ['DSS — Tactical > FBA', dssFor(cfg, 'TAC_TO_FBA')],
    ['Priority (B2B / Critical) DOI', cfg.RULES.PRIORITY_DOI],
    ['Pass 1 gate', 'reserved/fulfillable > ' + cfg.RULES.PASS1_RESERVED_RATIO
      + ', available-only DOI < ' + cfg.RULES.PASS1_AVAILABLE_DOI],
    ['Pass 1 caps', cfg.RULES.PASS1_DOI_CAP + ' DOI, single case to '
      + cfg.RULES.PASS1_SINGLE_CASE_CAP],
    ['Contention threshold', 'FBA DOI < ' + cfg.RULES.FBA_DOI_CONTENTION
      + ' serves Tactical > FBA first'],
    ['Pallet minimum', cfg.RULES.PALLET_MIN_CASES + ' cases'],
    ['Pallet fill ceiling', 'AWD DOI ' + cfg.RULES.PALLET_FILL_MAX_AWD_DOI
      + ', max ' + cfg.RULES.PALLET_FILL_MAX_CASES_PER_SKU + ' cases/SKU'],
    ['', ''],
    ['Tactical > AWD', plan.totals.tacToAwdCases + ' cases'],
    ['AWD > FBA', plan.totals.awdToFbaCases + ' cases'],
    ['Tactical > FBA', plan.totals.tacToFbaCases + ' cases'],
    ['', ''],
    ['Pallet: demand-driven', pallet.demandCases + ' cases'],
    ['Pallet: filled forward', pallet.filledCases + ' cases'],
    ['Pallet: status', palletStatus(pallet)],
    ['', ''],
    ['Rows needing review', plan.totals.needsReview],
    ['Rows flagged LTF', plan.totals.ltfHeld],
    ['Tactical floor breaches', plan.totals.floorBreaches],
    ['SKUs on CRITICAL', input.meta.criticalCount],
    ['SKUs on LTF', input.meta.ltfCount],
  ];

  sh.getRange(1, 1, lines.length, 2).setValues(lines);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground(cfg.COLOURS.HEADER);
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 560);

  // Colour the three verdicts so a held lane cannot be mistaken for a live one.
  var verdictAt = labelRow(lines, 'RAISE THIS ORDER?');
  if (verdictAt) {
    sh.getRange(verdictAt, 1, 1, 2).setFontWeight('bold')
      .setBackground(cfg.COLOURS.HEADER);
    [v.tacToAwd, v.awdToFba, v.tacToFba].forEach(function (lane, i) {
      sh.getRange(verdictAt + 1 + i, 1, 1, 2)
        .setBackground(lane.raise ? cfg.COLOURS.PASS_2 : cfg.COLOURS.PALLET_FILL);
    });
  }

  // §6.1: an under-full pallet is surfaced here rather than shipped quietly.
  if (pallet.shortfall > 0) {
    var at = labelRow(lines, 'Pallet: status');
    if (at) sh.getRange(at, 2).setBackground(cfg.COLOURS.NEEDS_REVIEW);
  }
  return sh;
}

/** 1-based row of a label in the run header, or 0 if it moved. */
function labelRow(lines, label) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i][0] === label) return i + 1;
  }
  return 0;
}

function palletStatus(p) {
  if (p.skipped) return 'no demand — no shipment suggested';
  if (p.shortfall > 0) {
    return 'SHORT by ' + p.shortfall + ' cases — filler pool exhausted at '
      + (p.demandCases + p.filledCases) + ' of ' + p.target;
  }
  if (p.filledCases > 0) {
    return 'topped up to ' + (p.demandCases + p.filledCases) + ' cases';
  }
  return 'met by demand (' + p.demandCases + ' cases)';
}

// ========================================================================
// Backtest.gs
// ========================================================================

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

// ========================================================================
// Authorise.gs
// ========================================================================

/**
 * Pre-approving the IMPORTRANGE links this planner depends on.
 *
 * A fresh copy of the template has to be told, once per source workbook, that
 * it may pull from it — otherwise every IMPORTRANGE returns #REF! until someone
 * clicks "Allow access" in the cell. That click is easy to miss, and missing it
 * is not harmless: the Tactical floor arrives as #REF!, and a floor that cannot
 * be read used to read as no floor at all.
 *
 * Google exposes no supported API for this. The endpoint below is the one the
 * Sheets front-end itself calls when you click Allow, driven with the script's
 * own OAuth token. It is undocumented, so it is written to fail softly: a
 * refusal here is reported, never thrown, and the run still refuses to draw on
 * a floor it cannot see.
 */

/**
 * Grant this spreadsheet permission to import from every known source.
 * Returns [{ id, ok, status }] — one entry per donor, in the order tried.
 */
function authoriseDataSources(planner, cfg) {
  var ss = planner || SpreadsheetApp.getActiveSpreadsheet();
  var conf = cfg || config();
  var donors = donorIds(ss, conf);
  var token = ScriptApp.getOAuthToken();
  var destId = ss.getId();

  return donors.map(function (donorId) {
    var url = 'https://docs.google.com/spreadsheets/d/' + destId
      + '/externaldata/addimportrangepermissions?donorDocId=' + donorId;
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      return { id: donorId, ok: code >= 200 && code < 300, status: 'HTTP ' + code };
    } catch (e) {
      return { id: donorId, ok: false, status: e.message };
    }
  });
}

/**
 * Every workbook this planner imports from: the ones named in Config, plus any
 * other ID found inside an IMPORTRANGE on the sheet.
 *
 * Scanning the formulas matters more than the configured list — someone adds an
 * IMPORTRANGE to a tab long before anyone thinks to add its ID here, and the
 * symptom of missing one is a silent #REF! rather than an error.
 */
function donorIds(ss, cfg) {
  var seen = {};
  var out = [];
  function add(id) {
    if (!id || id === ss.getId() || seen[id]) return;
    seen[id] = true;
    out.push(id);
  }

  [cfg.SOURCES.IMS_ID, cfg.SOURCES.MIN_UNITS_ID].forEach(add);
  (cfg.SOURCES.EXTRA_IMPORT_SOURCES || []).forEach(add);

  ss.getSheets().forEach(function (sh) {
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
    var formulas;
    try {
      formulas = sh.getRange(1, 1, Math.min(sh.getLastRow(), 200),
        sh.getLastColumn()).getFormulas();
    } catch (e) {
      return;
    }
    formulas.forEach(function (row) {
      row.forEach(function (f) {
        if (!f || f.indexOf('IMPORTRANGE') === -1) return;
        var m = f.match(/[-\w]{25,}/g);
        if (m) m.forEach(add);
      });
    });
  });

  return out;
}

/** Menu entry: authorise, then say what happened. */
function authoriseDataSourcesMenu() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = authoriseDataSources(ss, config());
  var ui = SpreadsheetApp.getUi();

  if (!results.length) {
    ui.alert('Nothing to authorise', 'No IMPORTRANGE sources found in this file.',
      ui.ButtonSet.OK);
    return results;
  }

  var lines = results.map(function (r) {
    return (r.ok ? '✓ ' : '✗ ') + r.id + '  (' + r.status + ')';
  });
  var failed = results.filter(function (r) { return !r.ok; }).length;
  lines.unshift(results.length - failed + ' of ' + results.length + ' authorised.', '');
  if (failed) {
    lines.push('', 'For any that failed, open the cell showing #REF! and click',
      '"Allow access" once. That grant is per source workbook and sticks.');
  }
  ui.alert('Data sources', lines.join('\n'), ui.ButtonSet.OK);
  return results;
}

// ========================================================================
// History.gs
// ========================================================================

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

// ========================================================================
// Menu.gs
// ========================================================================

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
    .addItem('Authorise data sources', 'authoriseDataSourcesMenu')
    .addSeparator()
    .addItem('Record what shipped (after raising the orders)', 'recordShippedMenu')
    .addItem('Scorecard — proposal vs shipment', 'historyScorecardMenu')
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

  var lines = verdictLines(plan).concat([
    '',
    'Pallet: ' + palletStatus(plan.pallet),
    'Needs review: ' + plan.totals.needsReview,
    'LTF flagged:  ' + plan.totals.ltfHeld,
    'Floor breaches: ' + plan.totals.floorBreaches,
    '',
    'Tactical floor from: ' + input.meta.minUnitsSource,
  ]);
  SpreadsheetApp.getUi().alert('Dry run — nothing written', lines.join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
  return plan;
}

/** Read, decide, write. The one path both menu items share. */
function runPlan(planner, cfg, ctx) {
  // Clear the IMPORTRANGE grants before reading, so a fresh copy does not plan
  // against a sheet full of #REF!.
  authoriseDataSources(planner, cfg);
  var input = readPlanningInput(planner, cfg);
  var plan = planUsTransferOrders(input, cfg);
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
  ui.alert('Plan built',
    ss.getName() + '\n\n'
    + verdictLines(p).join('\n') + '\n\n'
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
