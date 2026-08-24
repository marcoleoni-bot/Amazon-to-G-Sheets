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

    /** Where the history workbook gets created if it does not exist yet. */
    HISTORY_FOLDER_ID: '1M4reJpAvhw1q7hQeO7sDTZ4NcHmAFjUr',

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

    /**
     * The IMS tabs each lane is fed from. Pinned, never guessed.
     *
     * All three carry the same first six headers — B2B, name, Mrkt,
     * true_rate_30, order_plan_rate, product_life_cycle — so header matching
     * cannot tell them apart. It picked the wrong one on 08-24 and put 491
     * rows into a 29-row lane; every number after that was arithmetic on the
     * wrong table. Note the planner's Tactical > AWD tab has a trailing space
     * and the IMS one does not.
     */
    IMS_LANE_TABS: {
      TAC_TO_AWD: 'US TO Tactical > AWD',
      AWD_TO_FBA: 'US TO AWD > FBA',
      TAC_TO_FBA: 'US TO Tactical > FBA',
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
    SETTINGS: 'Settings',
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

  /**
   * Step one: pull current values out of the IMS into the planner's lane tabs.
   *
   * The planner is a copy of the previous run, so without this every lane still
   * holds the previous run's numbers and the whole plan is correct arithmetic
   * on stale inputs.
   */
  /**
   * Which columns hold pasted values and which hold formulas.
   *
   * Inputs are frozen at run time — stock, rates, case sizes — so the planner
   * stays a record of the numbers the decision was made on. Everything derived
   * from them is a formula, so changing a rate reprices the projection in front
   * of you instead of requiring another run.
   */
  FORMULAS: {
    /** Write them on every run. Off leaves whatever is already in the sheet. */
    ENABLED: true,
  },

  REFRESH: {
    /** Do it automatically at the start of every run. */
    ENABLED: true,

    /**
     * Columns the refresh must not touch, 0-based, per lane.
     *
     * The Tactical minimum is not in the IMS — it is looked up from the B2B tab
     * and kept visible on purpose. Pasting over it is how a floor of 100 turns
     * into a floor of nothing, which is the failure that emptied five SKUs.
     */
    PRESERVE_COLS: {
      TAC_TO_AWD: [1],   // B  min. units at Tactical
      AWD_TO_FBA: [1],   // B  Critical?  (a planner-side lookup)
      TAC_TO_FBA: [1, 2], // B min. units, C Critical?
    },

    /** How much of the header must match before a tab is accepted as the source. */
    HEADER_MATCH_MIN: 0.6,
  },

  HISTORY_FILE_NAME: 'US TO history',

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
  'REFRESH.ENABLED',
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
