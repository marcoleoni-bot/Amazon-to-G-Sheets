# US Transfer Order Planner

Apps Script bound to the US TO planner. One click turns the 30–60 minute
hand-typing exercise into a reviewable proposal: a suggested case quantity for
every SKU on every lane, each with a reason code you can argue with.

It proposes. Marco decides. Nothing here creates a shipment.

---

## What it does

**Transfer Orders → ▶ Build this week's plan** copies the template into
`Transfer orders / MM. Month / US /` as a dated file and does the whole run:

1. authorises the IMPORTRANGE links, so nothing reads `#REF!` where a floor
   should be
2. builds the **Settings** tab and its named ranges
3. pastes current values out of the IMS — **inputs only**
4. writes every derived column as a **live formula**
5. runs the rule engine over what the sheet worked out, reconciles the two, and
   writes reasons, colours, summaries, CSV tabs and the run header

Then hand-check it, override anything you disagree with, and raise the orders.

### Values below, formulas above

Every bug this planner has had has been the same bug: a number worked out
somewhere else and pasted in, where a failed input silently became zero. A
floor that read `#REF!` became no floor. The arithmetic was always right and
the answer was always wrong, and nothing on the sheet showed which.

So the split is deliberate:

| | |
|---|---|
| **pasted as values** | stock, rates, case sizes, lifecycle, the Tactical floor — frozen at run time, so the planner stays a record of the numbers the decision was actually made on |
| **live formulas** | days of cover, cases to transfer, units, cover after the transfer — all of it visible, all of it referencing the Settings tab by name |

Change the rate in column `F` and the projection moves in front of you. Change
`TacAwd_TargetDoi` on the Settings tab from 75 to 90 and the whole column
reprices. Nothing has to be re-run to see the effect of a what-if.

Each lane also gains a few working columns to the right of `Reason`, so the
numbers behind a decision are on the row rather than implied by it:

| Lane | Columns |
|---|---|
| Tactical > AWD | *Drawable after the Tactical floor*, *Qualifying cases* |
| AWD > FBA | *Pass* (1/2/3), *Target*, *Cases needed to reach the target*, *Cases AWD could not cover* |
| Tactical > FBA | *Target*, *Ceiling*, *Cases AWD could not cover*, *Wanted before the ceiling*, *Wanted before stock and the floor* |

`Drawable after the Tactical floor` is the answer to the question that kept
coming back: *112 units, a floor of 100, cases of 12 — why one case?* Because
one is what the floor leaves, and now the sheet says so.

### The reason column still explains it in words

```
0 — already 118 DOI
20 cases — top-up to 100 DOI (B2B), capped by AWD stock
6 cases — reserved-blocked, top-up available-only to 42 DOI
0 — 1 case would reach 114 DOI (>110)
0 — Tactical floor (min 240 units) reached
```

### Cross-lane lookups are INDEX/MATCH, never a VLOOKUP block

The lanes have to see each other: Tactical > AWD needs what Tactical > FBA is
taking off the same pallet, Tactical > FBA needs what AWD could not cover, and
what is already inbound to AWD.

Each of those edges is `INDEX(<one column>, MATCH(<sku>, <sku column>, 0))` —
two single columns, never `VLOOKUP(sku, 'Other lane'!$D:$S, 16, FALSE)`.

That is not style. A block VLOOKUP makes the cell depend on sixteen whole
columns of the other lane, which has its own block lookup pointing back over
ten of ours. No individual cell forms a loop — every back-edge lands on a
pasted input in the end — but Sheets resolves open ranges at range granularity,
sees two sheets each referencing a wide slab of the other, and calls it a
circular dependency. The entire transfer column then reads `#REF!`, and
`IFERROR` cannot catch it: a circular cell is marked circular rather than given
an error value.

`test/planner-formulas.test.js` builds the dependency graph from the generated
formulas at **column** granularity — as coarse as Sheets is — and fails if it
finds a cycle. A second test refuses any cross-sheet VLOOKUP block outright.

### Named ranges are moved, never deleted

Deleting a named range in Sheets rewrites every formula that referenced it,
on the spot, to the literal text `#REF!`. Re-creating the name a moment later
does not undo that — the formulas have already been edited.

`ensureSettings` used to remove and re-create all of them on every run, so
every plan began by shredding the formulas the previous plan had written. It
self-repaired whenever the run got as far as rewriting the lanes, and did not
when it didn't, which is how AWD > FBA came back full of

```
ROUNDUP((#REF!-N($Y8))*...        where AwdFba_Pass1TargetDoi had been
IF(N($J8)+N($O8)<#REF!,...        where Dss_BaselineDoi had been
```

Existing names are now re-pointed with `setRange()`, which touches no formula.
A workbook already carrying that damage is repaired by the next run, since
every calculated column is rewritten from scratch.

### The per-SKU unit floor at FBA

`Fba_MinUnitsBySku` — `101-4001 → 100` — is a count of stock somebody decided
must be there, not a days-of-cover judgement. So it outranks every DOI rule on
**both** lanes that can reach FBA:

- **AWD > FBA** fills it first, above its own three passes and above the 110
  ceiling. It reaches the quantity through the target column, so *Cases needed
  to reach the target* reads as the floor requirement and the shortfall carried
  onward is measured against the floor too.
- **Tactical > FBA** covers whatever is left, and skips the residual and
  inbound gates to do it. Those gates ask whether AWD could have covered a
  days-of-cover target and whether replenishment is on its way to AWD; neither
  is the question when the instruction is "never hold fewer than 100 units".
  It nets off what AWD is sending this run — column X — so the two lanes fill
  the floor once between them rather than twice.

Only Tactical > FBA knew about the floor before, and that lane is strictly
residual. So when AWD looked at 101-4001, decided its cover was fine and sent
nothing, the residual gate read "AWD found no need" and shut. Nobody filled the
floor and nothing said so.

### Two implementations, checked against each other

The rules exist twice: in `Rules_*.gs` and in the formulas. Two
implementations drift, so every run compares them row by row. Where they
differ **the sheet wins** — it is the number on the row, the one that gets
picked and shipped — and the row is flagged with what the rule engine thought
instead. The run dialog reports the count. Drift is loud rather than silent.

`npm test` goes further: `test/helpers/sheet-eval.js` is a small Sheets formula
evaluator, and `test/planner-formulas.test.js` runs both implementations over
the same fixtures and requires the same answer.

## Install

**By hand — one paste.** Open the planner → Extensions → Apps Script. Delete
the stub `Code.gs` contents, paste all of
[`dist/Code.gs`](dist/Code.gs), Save. That file is every module concatenated;
Apps Script runs them in one global scope anyway, so a single file behaves
identically. Then Project Settings → time zone → *(GMT-05:00) New York*.

**With [clasp](https://github.com/google/clasp)** if you'd rather keep the
modules separate:

```bash
npm i -g @google/clasp && clasp login
cd apps-script
clasp create --type sheets --title "US TO Planner" --rootDir .
clasp push
```

Either way, reload the spreadsheet once so `onOpen` installs the menu. Run
**Dry run** first and accept the OAuth prompt — it needs Sheets (read/write),
Drive (to make the dated copy) and the UI scope for the menu.

`dist/Code.gs` is generated. Edit the modules and run `npm run bundle`; a test
fails if the bundle has drifted from them.

## Modules

| File | What lives there |
|---|---|
| `Config.gs` | every ID, tab name, column index and default threshold |
| `Lib.gs` | pure helpers — `num`, `roundUp`, `dssLadder`, reason formatting |
| `Read.gs` | sheets in, plain objects out |
| `Settings.gs` | the dials, as a tab of named ranges, read back into config |
| `Formulas.gs` | the lanes as formulas, and the reconciliation against the rules |
| `Refresh.gs` | IMS inputs in, pasted as values, calculated columns untouched |
| `Rules_AwdToFba.gs` | passes 1–3 |
| `Rules_TacToAwd.gs` | the two-ended gate, the floor, the pallet test |
| `Rules_TacToFba.gs` | the residual gates |
| `Allocate.gs` | contention, and the pipeline that orders the lanes |
| `Write.gs` | reasons, colours, summaries, CSVs, run header |
| `Authorise.gs` | pre-approving the IMPORTRANGE links |
| `History.gs` | the append-only TO log and the scorecard |
| `Menu.gs` | `onOpen`, `buildPlan`, the dated copy |
| `Backtest.gs` | replay a past planner and diff it |

The rule layer touches no Apps Script service. That is what lets `npm test` run
it: `test/helpers/load-gs.js` evaluates the real `.gs` files in one sandbox,
the same way Apps Script concatenates them, so the tests exercise shipped code
rather than a Node-flavoured copy of it.

```bash
npm test                                     # no network
node --test test/planner-rules.test.js       # 54 rule tests
node --test test/planner-formulas.test.js    # 40 formula tests
```

## How far the formulas run

Three separate things once got this wrong at once, on 09-09:

- **The row count came from the sheet.** `getLastRow()` on the Tactical > AWD
  tab said 5741 against 491 SKUs, so 5,734 rows of transfer formulas went in.
  The count now prefers what the refresh just pasted — the one number in the
  run that is known rather than inferred — and falls back to scanning the SKU
  column.
- **The scan stretched to meet a stray cell.** "Last non-blank in the column"
  finds a leftover value thousands of rows below the data and fills everything
  in between. A lane's SKU list is contiguous, so the scan now stops after
  `LANE_BLANK_RUN` (25) consecutive blanks.
- **The tail-clear was defeated by the state it was meant to repair.** It ran
  after the write and measured against `getLastRow()` — the very number the
  over-long write had corrupted — so it computed a tail of nothing. It now runs
  *first* and clears to `getMaxRows()`.

And a lane that silently received no formulas — Tactical > FBA came out of that
run with its headers written and not one calculated cell underneath, so the
residual lane proposed nothing all week and looked settled rather than broken —
now stops the run with an error naming the lane.

## The Settings tab

Every dial the lanes use lives on a tab called **Settings**, one per row, each
a named range the formulas reference:

| Named range | Is |
|---|---|
| `Dss_BaselineDoi` | 60 — the baseline target |
| `Priority_Doi` | 100 — B2B and Critical |
| `TacAwd_GateAwdDoi` / `TacAwd_GateFbaDoi` | 100 / 100 — short at both ends or nothing |
| `TacAwd_TargetDoi` | 75 — where AWD is topped up to |
| `Pallet_MinCases` | 25 — under this the whole run holds |
| `AwdFba_Pass1TriggerDoi` / `AwdFba_Pass1TargetDoi` | 40 / 42 |
| `AwdFba_ReservedRatio` | 0.5 |
| `AwdFba_Pass2TriggerDoi` | 100 |
| `AwdFba_MaxDoiAfter` | 110 — never leave FBA above this |
| `TacFba_DiscontinuedAimDoi` / `TacFba_DiscontinuedMaxDoi` | 50 / 110 |
| `TacFba_FloorBreachMaxDoi` | 30 — and the two that bound the rescue |
| `Fba_MinUnitsBySku` | a two-column table; `101-4001 → 100` |
| `Run_TacAwdQualifyingCases` / `Run_TacAwdVerdict` | derived — the pallet test |

Editing a value changes both the formulas *and* the rule engine on the next
run: `configFor()` reads the tab back over `Config.gs`, so the two cannot
disagree about what 75 means. Clearing a cell restores the `Config.gs` default.

`Config.gs` is still where the defaults live, and Script Properties still
override those — the tab wins over both, because it is the one a human can see.
**Tools → Settings in force** prints the resolved set.

## Which IMS tab feeds which lane

Pinned in `SOURCES.IMS_LANE_TABS`, never guessed:

```
TAC_TO_AWD   US TO Tactical > AWD      (the planner's own tab has a trailing space)
AWD_TO_FBA   US TO AWD > FBA
TAC_TO_FBA   US TO Tactical > FBA
```

There used to be a header-matching fallback. It cannot work: all three IMS
lane tabs open with the same six headers — `B2B`, `name`, `Mrkt`,
`true_rate_30`, `order_plan_rate`, `product_life_cycle` — so every one of them
scores identically against every lane. On 08-24 it chose `US TO AWD > FBA` to
feed the Tactical > AWD lane and pasted 491 rows into a tab with 29, and every
number after that was correct arithmetic on the wrong table. A pinned name that
goes missing now fails loudly and names the config key, which is the only safe
way for this to go wrong. Two lanes pinned to the same tab is refused outright.

`SOURCES.LANES_FROM` picks where the rule engine reads from. `'planner'` (the
default) reads the planner's own lane tabs. `'ims'` reads the IMS directly.
The default is `'planner'` for a specific reason: a past planner carries its
own snapshot and the IMS does not, so it is the only mode a back-test can run
in.

## Back-testing

**Transfer Orders → Back-test this file against its own numbers** replays a
past planner through the live rules and writes a `Back-test` tab. It reads
only — it never touches the lane columns of the file under test.

**What it compares against matters more than anything else here.** Not the lane
decision columns: those travel with the file when it is copied, so they hold a
blend of several weeks' typing. What actually shipped is recorded elsewhere:

| Lane | Truth |
|---|---|
| Tactical → AWD | `CSV upload TACTICAL AWD` |
| Tactical → FBA | `CSV upload TACTICAL FBA` |
| AWD → FBA | the `AWD TO FBA` pick list |

and the CSV tabs carry a `trandate`. **A CSV tab that is empty, or dated to
another day, means nothing shipped on that lane that run** — zeros, not missing
data. The script now stamps the trandate with the planner's own date rather
than today's, so the convention keeps working on files it writes.

### Results across six runs

`07-06`, `07-13`, `07-20`, `07-27`, `08-04`, `08-10`, at spec defaults:

| Run | AWD → FBA rows matching | Cases shipped | Cases script |
|---|---|---|---|
| 07-06-26 | 461/491 (94%) | 115 | 187 |
| 07-13-26 | 467/491 (95%) | 75 | 132 |
| 07-20-26 | 468/491 (95%) | 97 | 243 |
| 07-27-26 | 466/491 (95%) | 135 | 200 |
| 08-04-26 | 459/491 (93%) | 147 | 201 |
| 08-10-26 | 463/491 (94%) | 112 | 129 |
| **total** | **2784/2946 (94.5%)** | **681** | **1092** |

Row agreement is steady at ~94.5%. The volume is not: the script proposes 60%
more cases than actually left AWD, and the bias is one-sided — 116 rows where
it sends more against 46 where it sends less.

### One rule explains almost all of it

§5 pass 2 has no DOI trigger. Its gate is "B2B **or** Critical", so a priority
SKU is topped to 100 DOI on *every* run — including one already sitting on 88.
On 07-20, `101-2104` (Critical, 88 DOI) draws 8 cases from the rules and
shipped none; `101-2110` (B2B, 49 DOI) draws all 81 cases in AWD against the
22 that shipped.

Adding a trigger — top up only once cover falls below the baseline — fixes the
bias almost exactly:

| Pass 2 fires | Rows matching | Cases script vs 681 shipped | Rows over/under |
|---|---|---|---|
| always (spec, default) | 94.5% | 1092 (+60%) | 116 / 46 |
| **below 60 DOI** | **94.8%** | **658 (−3%)** | **77 / 75** |
| below 70 DOI | 94.7% | 831 (+22%) | 88 / 68 |
| below 80 DOI | 94.7% | 944 (+39%) | 98 / 58 |
| never | 94.9% | 349 (−49%) | 66 / 84 |

At 60 the total volume lands within 3% and the over/under split becomes even —
the signature of a corrected bias rather than a tuned fit. 60 is also the
baseline the spec already uses, which makes the rule read coherently: *a
priority SKU that drops below the baseline is restored to 100 rather than 60.*

The default is still the spec's behaviour, because the spec is what was signed
off. Flip it with one Script Property:

```
RULES.PASS2_TRIGGER_DOI    60
```

### Tactical ships about once in six runs — and now the rules agree

The pallet minimum is a constraint on a shipment, not a reason to make one.
Read the other way round it produces exactly the wrong answer: five cases of
genuine need padded with twenty cases of SKUs that needed nothing, purely to
fill a pallet. More work, more freight, more stock parked at AWD than doing
nothing would have been.

So the lane now asks **whether the run is worth raising at all**, before the
pallet minimum applies. A SKU is urgent only when *both* hold:

```
AWD cover  <  TAC_TO_AWD_URGENCY_AWD_DOI   (30)   — the buffer is thin
AND FBA cover  <  TAC_TO_AWD_HEALTHY_FBA_DOI (60) — and FBA cannot bridge it
```

Both, not either — and that is the whole trick. `101-2102` holds no AWD stock
at all, which reads as **0 days of cover**, the most alarming number on the
tab. It also sits on **599 days at FBA** and sells a sixth of a unit a day.
Read AWD alone and the quietest SKU in the catalogue justifies a pallet every
week; that first cut of this rule raised a run on all six.

If nothing is urgent, the lane is zeroed, each row that wanted stock says what
it would have sent and why it is waiting, and the verdict names the thinnest
SKU. Only once a run is justified does the pallet fill top it to 25, because by
then the pallet is being paid for regardless.

| Run | Reality | Verdict | Rows matching |
|---|---|---|---|
| 07-06-26 | nothing shipped | raise, 25 cases | 15/26 |
| 07-13-26 | nothing shipped | **hold** | **30/30** |
| 07-20-26 | nothing shipped | **hold** | **30/30** |
| 07-27-26 | nothing shipped | **hold** | **30/30** |
| 08-04-26 | nothing shipped | **hold** | **30/30** |
| 08-10-26 | **35 cases** | **raise, 36 cases** | 17/29 |

Five of six agree, including the one run that actually shipped. The miss is
07-06, where `101-2110` (25 DOI) and `101-2003` (27 DOI) sit just under the
threshold — tightening it to 25 would hold that run too, but six runs is not
enough evidence to tune a threshold that finely.

One knock-on worth watching: holding the AWD lane frees Tactical stock, so
Tactical → FBA now proposes more than it did — 23 cases on 08-04 against the
nothing that shipped. That lane is meant to be rare, so if it keeps proposing
double figures it needs the same urgency treatment.

## Every lane says whether to raise the order

The first thing on the `Run header` tab, and the first thing both dialogs say:

```
RAISE THIS ORDER?
Tactical → AWD    NO  — nothing urgent — thinnest is 101-2041 at 0 DOI at AWD,
                        FBA on 82. 88 cases of demand would need 0 of filler
AWD → FBA         YES — 29 SKUs, 112 cases
Tactical → FBA    NO  — AWD is covering every shortfall
```

Green for raise, grey for hold, so a held lane cannot be mistaken for a live
one. The `AWD TO FBA` tab stays the pick list — SKU, case qty, units, cases —
and the full scenario for every SKU stays on the lane tab beside it.

## Every Thursday

1. **Transfer Orders → ▶ Build this week's plan.** It makes the dated copy in
   `Transfer orders / 08. August / US /`, pulls the IMS, rebuilds the formulas
   and decides all three lanes. Everything else on this list is checking.
2. Read the **RAISE THIS ORDER?** block in the dialog and on `Run header`.
   A lane that says NO says why in the same line.
3. On any lane that says YES, scan the `Reason` column. Amber is *worth a
   second look*, red is LTF, and a thick red border is a floor breach.
4. Disagree with something? Change the input, not the answer. Adjust the rate
   in column `F`, or a dial on the **Settings** tab, and every projection moves
   with it. If you type over a transfer quantity you replace that row's formula
   with a fixed number — fine for a one-off, but it stops reacting.
5. Raise the orders from the pick lists — `AWD TO FBA`, `To transfer Tac-AWD`,
   `To transfer Tac-FBA` — and the CSV tabs.
6. **Transfer Orders → Record what shipped.** That closes the loop: the history
   workbook then holds proposed *and* shipped for every SKU, and
   **Tools → Scorecard** shows where the rules and reality part company.

Only step 1 is a command. If a dial needs changing, change it on the Settings
tab and use **↻ Re-plan this file** — no new copy, same numbers, new answer.

## The Tactical floor

Held in three places now, which is two more than before:

- **In the formula**, on the row: `Drawable after the Tactical floor (cases)`
  is `FLOOR((Tactical units − minimum − whatever Tactical > FBA is taking) /
  case qty)`, and the transfer column takes the smaller of that and demand.
- **In `Rules_TacToAwd.gs`**, where the quantity is produced.
- **In `Allocate.gs`**, which settles both Tactical lanes against one pool.

It kept being lost because it lived in only the last of those: on 08-19 four
SKUs holding exactly their 100-unit minimum shipped in full, because the only
cap was one step further on than the number. And on 08-24 it looked lost again
for a different reason — the lane had been filled from the wrong IMS tab, so
column B held floors for products that were not on those rows at all.

An unreadable floor is not a floor of zero. `#REF!` in column B — which is what
an unauthorised IMPORTRANGE leaves — stops the row rather than freeing it.

The two Tactical lanes draw on one pool, and a spreadsheet cannot settle that
circularly. In the sheet, **Tactical > FBA is settled first** and its units come
off the Tactical > AWD budget. That is the direction taken by hand anyway: the
SPD lane moves small rescue quantities, the palletised lane waits. §8's 40-DOI
switch still runs in `Allocate.gs`, so on the rare SKU where both lanes want
the same stock the two can differ — and the reconciliation flags exactly that.

It has **two sources**, and until 08-24 the workbook won outright whenever it
listed a SKU at all — including when it listed a blank, which reads as 0. That
is what emptied the floor for `101-2003`, `101-2110` and `101-2104` while
column B showed 100 on the row; the reason those rows carried
("capped by Tactical stock") is only reachable with the floor at zero. Both
are now read and the **larger** wins, because a floor is a minimum to hold
back and the higher reading is the safe direction. Disagreements are listed on
`Run header` rather than smoothed over.

The floor itself is read from the min-units workbook (§2), confirmed against
the formula in the planner's own column B:

```
=VLOOKUP(C9, IMPORTRANGE(".../14fW_-Gacy...", "B2B!A:E"), 5, 0)
```

Tab `B2B`, SKU in column A, floor in column E, exact match. The reader mirrors
VLOOKUP rather than assuming a header: row 1 is skipped only when it really
does carry both header labels, so a tab without one does not quietly lose its
first SKU. If the workbook cannot be opened it falls back to the planner's
column B and the run header says so, with the floor count either way.

Worth noticing what the tab's *name* implies: only B2B products carry a floor,
which is why column B is blank for everything else in the planner. That also
means the B2B list and the floor are the same read. Membership is not used as
a B2B flag by default (`MIN_UNITS.TREAT_AS_B2B`) — column A of each lane
already carries it and back-tests clean, and a false B2B flag silently moves a
SKU to the 100 DOI target. Turn it on once someone confirms that tab holds B2B
SKUs and nothing else.

## What needs a decision

All of these are values on the **Settings** tab — settling one is an edit to a
cell, not to code.

1. **The pallet minimum** (`Pallet_MinCases`). The spec says 25 and so did the
   08-13 walkthrough; a later message said "i think it was 20 cases". It is
   still 25. It decides whether a Tactical > AWD run goes at all, so it is
   worth being sure: change the cell and `Run_TacAwdVerdict` flips in front of
   you.

2. **The pass 2 trigger** (`AwdFba_Pass2TriggerDoi`). See above. This is the
   one with volume behind it: it is worth 60% of the proposed cases on the
   lane that runs every week.

3. **§7's quantity, stated twice and not identically.** "The smaller of (a) 1
   case and (b) cases to reach the target" is a minimum; "1 case, unless more
   is needed to reach the target" is a maximum. The worked example is 4 cases,
   and the real `101-2040` row is 4 cases where 4 were available, so the second
   reading is the default (`TAC_TO_FBA_QTY_MODE: 'to_target'`).

4. **The Tactical → FBA spike ceiling.** §7 gate 4 says the resulting FBA DOI
   must not spike but gives no number. Pass 1 is the only worked example of how
   far an indivisible case may overshoot — 100 to 110 — so that 1.1 ratio is
   reused (`TAC_TO_FBA_SPIKE_MULTIPLIER`).

One reading in §7 is worth flagging because it changes behaviour sharply.
"Discontinued → 100 DOI cap, never exceed" is a *cap*, not a target — it is
the only one of the three phrased that way. Read as a target it pushes 205
units of a liquidating SKU into FBA on the 08-10 data, against the 12 that
shipped. So discontinued SKUs get the minimum viable quantity and a hard 100
DOI ceiling.

Also worth knowing: the 08-10 planner had `DSS` set to **50** on the AWD → FBA
tab, not the 60 the spec calls for. The spec wins by default; set
`RULES.DSS_BY_LANE.AWD_TO_FBA` to reproduce a past run.

## Pallet filling no longer fires

§6.1 tops a short Tactical > AWD load up with SKUs that did not need anything,
to reach the 25-case pallet. In practice that is the wrong way round: five
cases of real need padded with twenty of filler is more work, more freight and
more stock sitting at AWD than doing nothing would have been.

So the run is now decided first and filled never. `decideTacToAwdRun()` raises
a run only once genuine demand already reaches the minimum, and
`applyPalletFill()` returns untouched at or above it — the two conditions no
longer overlap, so the fill cannot add a case. It is left wired up rather than
deleted because the spec asks for it and a different verdict rule would want it
back. The formulas implement none of it, so if it ever fires again every filled
row shows up as a disagreement in the reconciliation.

## Not built

Phase 2, in the spec's order of value: the shipments-tracker upload, Tactical
WMS outbound orders, and Seller Central shipment creation. The `AWD TO FBA`
summary tab is deliberately narrow — SKU, case qty, units, cases — so it reads
straight down while typing into Seller Central by hand.
