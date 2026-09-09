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

    // ---- the unit floor, which none of the gates below get to argue with --
    //
    // The residual gate asks whether AWD could have covered a days-of-cover
    // target, and the inbound gate asks whether replenishment is on its way
    // to AWD. Neither is the question when the instruction is "never hold
    // fewer than 100 units at FBA", so a SKU with a floor skips both and is
    // simply topped up to it — less whatever AWD is sending this run, so the
    // two lanes fill it once between them.
    var floorUnits = unitFloorFor(r.sku, R);
    if (floorUnits > 0) return unitFloorDecision(r, floorUnits, awdBySku);

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
    if (!t.liquidating && r.amzDoi >= t.target) {
      return decision(0, 'already ' + fmt(r.amzDoi) + ' DOI (target '
        + t.target + ')', { pass: 'NONE' });
    }

    var cases;
    if (t.minimumOnly || R.TAC_TO_FBA_QTY_MODE === 'single_case') {
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

    var how = t.liquidating ? 'liquidating discontinued stock, to ' : 'to ';
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
/**
 * Top a SKU up to its unit floor at FBA, less whatever AWD is sending.
 *
 * Reached before any of the residual gates, because the floor is not a
 * replenishment judgement — it is a count of stock somebody has decided must
 * be there. Tactical stock still caps it, and the Tactical floor still binds
 * it in Allocate.gs.
 */
function unitFloorDecision(r, floorUnits, awdBySku) {
  var awd = awdBySku[normSku(r.sku)];
  var fromAwd = awd ? (awd.units || 0) : 0;
  var cases = clampMin0(roundUp((floorUnits - r.amzTotal - fromAwd) / r.caseQty));

  if (cases === 0) {
    return decision(0, fromAwd > 0
      ? 'AWD is filling the ' + floorUnits + '-unit floor (' + fmt(fromAwd) + ' units)'
      : 'already ' + fmt(r.amzTotal) + ' units at FBA (floor ' + floorUnits + ')',
      { pass: 'NONE' });
  }

  var d = decision(cases, 'to the ' + floorUnits + '-unit floor at FBA', {
    pass: 'PASS_2',
    notes: [fmt(r.amzTotal) + ' units at FBA'
      + (fromAwd > 0 ? ', ' + fmt(fromAwd) + ' coming from AWD' : '')],
  });

  if (d.cases > r.availableCases) {
    d.cases = clampMin0(r.availableCases);
    addNote(d, d.cases === 0 ? 'no Tactical stock' : 'capped by Tactical stock');
    addFlag(d, 'NEEDS_REVIEW');
  }
  return d;
}

function fbaTarget(r, dss, R) {
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
