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
      // Units as well as cases: a unit floor is netted off in units, and the
      // two lanes have to fill it once between them rather than twice.
      units: (awdFbaDec[i].cases > 0 ? awdFbaDec[i].cases : 0) * r.caseQty,
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

  // 5 — the pallet minimum applies to a run that is going, and only then.
  //
  // Which means the fill can no longer add a case, and that is deliberate.
  // decideTacToAwdRun() only raises a run once demand already reaches the
  // minimum, and applyPalletFill() returns untouched at or above it, so the
  // two conditions no longer overlap. Filling was the thing Marco asked to be
  // rid of: five cases of genuine need padded with twenty of SKUs that needed
  // nothing, purely to fill a pallet.
  //
  // It is left wired up rather than deleted because §6.1 asks for it and a
  // different verdict rule would want it back. Nothing in the sheet formulas
  // implements it, so if it ever does fire again the reconciliation will
  // report every filled row as a disagreement — which is the right way to
  // find out.
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
