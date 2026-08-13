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
