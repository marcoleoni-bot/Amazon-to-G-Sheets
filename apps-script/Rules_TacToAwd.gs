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
  var dss = dssFor(cfg, 'TAC_TO_AWD');
  var R = cfg.RULES;

  var out = rows.map(function (r) {
    if (isDiscontinued(r)) {
      return decision(0, 'discontinued', { pass: 'NONE' });
    }
    if (!(r.rate > 0)) {
      return decision(0, 'no order_plan_rate', { pass: 'NONE' });
    }

    var want = clampMin0(
      dssLadder(dss, r.wrDoi, r.awdDoi, r.availableCases, r.rate, r.caseQty));

    if (want === 0) {
      return decision(0, 'AWD already ' + fmt(r.awdDoi) + ' DOI',
        { pass: 'PASS_3' });
    }

    var rule = (r.wrDoi + r.awdDoi < dss)
      ? 'Tactical + AWD under ' + dss + ' DOI, sending all available'
      : 'baseline ' + dss + ' DOI';

    var d = decision(want, rule, { pass: 'PASS_3' });

    // Stock cap. The floor is a separate, later constraint.
    if (d.cases > r.availableCases) {
      d.cases = clampMin0(r.availableCases);
      addNote(d, 'capped by Tactical stock');
      addFlag(d, 'NEEDS_REVIEW');
    }
    if (d.cases > R.REVIEW_ABOVE_CASES) {
      addNote(d, 'over ' + R.REVIEW_ABOVE_CASES + ' cases');
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
function assessUrgency(rows, decisions, cfg) {
  var R = cfg.RULES;
  var urgent = [];
  var thinnest = null;

  rows.forEach(function (r, i) {
    if (isDiscontinued(r) || !(r.rate > 0)) return;
    if (!decisions[i] || decisions[i].cases <= 0) return;

    if (thinnest === null || r.awdDoi < thinnest.awdDoi) thinnest = r;

    // Both, not either. AWD is a buffer in front of FBA, so an empty buffer
    // only matters when FBA is close enough to needing it.
    var thin = r.awdDoi < R.TAC_TO_AWD_URGENCY_AWD_DOI;
    var fbaCanHold = r.fbaDoi !== null && r.fbaDoi !== undefined
      && r.fbaDoi >= R.TAC_TO_AWD_HEALTHY_FBA_DOI;

    if (thin && !fbaCanHold) {
      urgent.push({
        sku: r.sku,
        awdDoi: r.awdDoi,
        fbaDoi: r.fbaDoi,
        cases: decisions[i].cases,
      });
    }
  });

  urgent.sort(function (a, b) { return a.awdDoi - b.awdDoi; });
  return { urgent: urgent, thinnest: thinnest };
}

/**
 * The lane's verdict: raise this transfer order, or hold it for a later run.
 *
 * Holding zeroes the lane rather than leaving numbers nobody intends to ship,
 * and every row that wanted stock says why it is being held instead.
 */
function decideTacToAwdRun(rows, decisions, cfg) {
  var R = cfg.RULES;
  var demand = decisions.reduce(function (s, d) { return s + (d.cases > 0 ? d.cases : 0); }, 0);
  var assessment = assessUrgency(rows, decisions, cfg);

  if (demand === 0) {
    return {
      raise: false, demandCases: 0, urgent: [],
      why: 'nothing below the ' + dssFor(cfg, 'TAC_TO_AWD') + ' DOI target at AWD',
    };
  }

  if (!assessment.urgent.length) {
    var t = assessment.thinnest;
    var why = 'nothing urgent — '
      + (t ? 'thinnest is ' + t.sku + ' at ' + fmt(t.awdDoi) + ' DOI at AWD'
        + (t.fbaDoi ? ', FBA on ' + fmt(t.fbaDoi) : '') : 'no SKU below '
        + R.TAC_TO_AWD_URGENCY_AWD_DOI + ' DOI')
      + '. ' + demand + ' cases of demand would need '
      + clampMin0(R.PALLET_MIN_CASES - demand) + ' cases of filler to make a pallet';

    rows.forEach(function (r, i) {
      if (decisions[i].cases <= 0) return;
      decisions[i] = decision(0, 'held for a later run', {
        pass: 'NONE',
        notes: ['would have sent ' + decisions[i].cases + ' cases, AWD on '
          + fmt(r.awdDoi) + ' DOI — not urgent'],
      });
    });

    return { raise: false, demandCases: demand, urgent: [], why: why, held: true };
  }

  return {
    raise: true,
    demandCases: demand,
    urgent: assessment.urgent,
    why: assessment.urgent.length + ' SKU' + (assessment.urgent.length === 1 ? '' : 's')
      + ' running thin at AWD — ' + assessment.urgent.slice(0, 3).map(function (u) {
        return u.sku + ' (' + fmt(u.awdDoi) + ' DOI)';
      }).join(', ') + (assessment.urgent.length > 3 ? ' and others' : ''),
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
