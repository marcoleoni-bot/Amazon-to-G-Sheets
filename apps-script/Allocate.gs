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
    if (!bySku[k]) bySku[k] = { awd: [], fba: [], available: 0, minUnits: 0, fbaDoi: null };
    return bySku[k];
  }

  awdRows.forEach(function (r, i) {
    var s = slot(r.sku);
    s.awd.push(i);
    s.available = Math.max(s.available, r.tacAvailableUnits);
    s.minUnits = Math.max(s.minUnits, r.minUnits);
    if (s.fbaDoi === null && r.fbaDoi !== undefined && r.fbaDoi !== null) s.fbaDoi = r.fbaDoi;
  });

  fbaRows.forEach(function (r, i) {
    var s = slot(r.sku);
    s.fba.push(i);
    s.available = Math.max(s.available, r.tacAvailableUnits);
    s.minUnits = Math.max(s.minUnits, r.minUnits);
    // The FBA lane's own AMZ_DOI is the authoritative figure for the 40 test.
    s.fbaDoi = r.amzDoi;
  });

  var headroomUnits = {};

  Object.keys(bySku).forEach(function (k) {
    var s = bySku[k];

    // Does any FBA-lane decision here carry the §7.1 breach permission?
    var breach = s.fba.some(function (i) {
      return fbaDec[i] && fbaDec[i].floorBreachAllowed && fbaDec[i].cases > 0;
    });

    var floor = breach ? 0 : s.minUnits;
    var pool = clampMin0(s.available - floor);

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
        var affordable = casesIn(pool, r.caseQty);

        if (wanted > affordable) {
          d.cases = clampMin0(affordable);
          if (d.cases === 0 && floor > 0) {
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

        if (breach && d.cases > 0 && lane.rows === fbaRows) {
          addFlag(d, 'FLOOR_BREACH');
          addNote(d, 'floor breached: ' + (d.floorBreachNote || 'exception'));
        }

        pool = clampMin0(pool - d.cases * r.caseQty);
      });
    });

    headroomUnits[k] = pool;
  });

  return { headroomUnits: headroomUnits };
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

  // 5 — pallet minimum
  var pallet = applyPalletFill(input.tacToAwd, tacAwdDec, cfg,
    alloc.headroomUnits, ltf);

  return {
    tacToAwd: tacAwdDec,
    awdToFba: awdFbaDec,
    tacToFba: tacFbaDec,
    pallet: pallet,
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

function sumCases(dec) {
  return dec.reduce(function (s, d) { return s + (d && d.cases > 0 ? d.cases : 0); }, 0);
}

function countFlag(dec, flag) {
  return dec.reduce(function (s, d) {
    return s + (d && d.flags && d.flags.indexOf(flag) !== -1 ? 1 : 0);
  }, 0);
}
