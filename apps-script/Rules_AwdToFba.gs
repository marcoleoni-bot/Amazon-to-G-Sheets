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
