# US Transfer Order Planner

Apps Script bound to the US TO planner. One click turns the 30–60 minute
hand-typing exercise into a reviewable proposal: a suggested case quantity for
every SKU on every lane, each with a reason code you can argue with.

It proposes. Marco decides. Nothing here creates a shipment.

---

## What it does

**Transfer Orders → Build US plan** copies the template into
`Transfer orders / MM. Month / US /` as a dated file, reads fresh values, runs
the three lanes with contention handling, and writes:

- case quantities into the decision columns (`N` / `P` / `Q`)
- units as a formula (`=N8*O8`) so overriding a case count keeps units honest
- a reason column (`X` / `AD` / `Y`) — `<qty> — <rule>[, <constraint>]`
- one colour per pass, plus amber for review, red for LTF, grey for pallet fill
- regenerated summary and CSV tabs
- a `Run header` tab recording the timestamp, the dials used, and totals per lane

```
0 — already 118 DOI
20 cases — top-up to 100 DOI (B2B), capped by AWD stock
6 cases — reserved-blocked, top-up available-only to 42 DOI
0 — 1 case would reach 114 DOI (>110)
2 cases — pallet fill, pulled forward from next run
0 — Tactical floor (min 240 units) reached
```

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
| `Config.gs` | every ID, tab name, column index and threshold |
| `Lib.gs` | pure helpers — `num`, `roundUp`, `dssLadder`, reason formatting |
| `Read.gs` | sheets in, plain objects out |
| `Rules_AwdToFba.gs` | passes 1–3 |
| `Rules_TacToAwd.gs` | DSS ladder + pallet fill |
| `Rules_TacToFba.gs` | the residual gates |
| `Allocate.gs` | contention, and the pipeline that orders the lanes |
| `Write.gs` | quantities, reasons, colours, summaries, CSVs, run header |
| `Menu.gs` | `onOpen`, `buildPlan`, the dated copy |
| `Backtest.gs` | replay a past planner and diff it |

The rule layer touches no Apps Script service. That is what lets `npm test` run
it: `test/helpers/load-gs.js` evaluates the real `.gs` files in one sandbox,
the same way Apps Script concatenates them, so the tests exercise shipped code
rather than a Node-flavoured copy of it.

```bash
npm test                                  # 45 rule tests, no network
node --test test/planner-rules.test.js
```

## Configuration

Every threshold is in `Config.gs` — `60, 100, 110, 42, 40, 25, 7, 0.5` and the
rest. Nothing is inline in a rule.

To change one without editing code, add a Script Property (File → Project
properties → Script properties) using the dotted path as the key:

```
RULES.DSS                      60
RULES.DSS_BY_LANE.AWD_TO_FBA   50      # per-lane override; blank = use DSS
RULES.PALLET_MIN_CASES         25
RULES.TAC_TO_FBA_QTY_MODE      to_target
```

**Transfer Orders → Show settings** prints what is actually in force.

`SOURCES.LANES_FROM` picks where lane values come from. `'planner'` (the
default) reads the planner's own lane tabs, which the template populates from
the IMS with the formulas already in it. `'ims'` reads the IMS lane tabs
directly — same layout, same reader; fill in `SOURCES.IMS_LANE_TABS` first.
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

## The Tactical floor

Read straight from the min-units workbook (§2), confirmed against the formula
in the planner's own column B:

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

Four, all config values — settling them is a value change, not an edit.

1. **The pass 2 trigger** (`RULES.PASS2_TRIGGER_DOI`). See above. This is the
   one with volume behind it: it is worth 60% of the proposed cases on the
   lane that runs every week.

2. **The pallet-fill ceiling** (§12, explicitly left open).
   `PALLET_FILL_MAX_AWD_DOI` defaults to 100 and
   `PALLET_FILL_MAX_CASES_PER_SKU` to 2. Both conservative. With only two
   eligible SKUs the second caps the fill at 4 cases, and the run header
   reports the shortfall rather than shipping an under-full pallet.

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

## Not built

Phase 2, in the spec's order of value: the shipments-tracker upload, Tactical
WMS outbound orders, and Seller Central shipment creation. The `AWD TO FBA`
summary tab is deliberately narrow — SKU, case qty, units, cases — so it reads
straight down while typing into Seller Central by hand.
