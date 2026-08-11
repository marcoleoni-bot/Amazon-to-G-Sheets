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
npm test                                  # 35 rule tests, no network
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
past planner through the live rules and writes a `Back-test` tab: per-lane
match counts, then every difference with the inputs beside both numbers. It
reads only — it never overwrites the lane columns of the file under test.

### Results against `08-10-26`

Run at spec defaults (DSS 60 on every lane):

| Lane | Rows | Same | Differ | Cases typed | Cases script |
|---|---|---|---|---|---|
| AWD → FBA | 491 | 471 | 20 | 122 | 129 |
| Tactical → AWD | 29 | 18 | 11 | 51 | 36 |
| Tactical → FBA | 29 | 27 | 2 | 16 | 1 |

96% agreement on the lane that matters most, with the rules reproducing Marco
exactly on rows like `101-2047` (16 cases), `101-2110` (6, capped by AWD
stock), `401-1037-ALS` (1, reserved-blocked) and every SKU already past target.

The differences are the interesting part. Each is either a bug here or a rule
nobody has written down, and they cluster:

1. **Pass precedence.** `101-1015-V2` is both reserved-blocked and Critical.
   §5 gives pass 1 the claim, which yields 2 cases; Marco typed 8, the pass 2
   number. Either §5's ordering is wrong, or priority SKUs should be exempt
   from pass 1.

2. **Tactical → AWD ran at roughly double the 60 DOI target.** `401-1001-G`
   typed 20 against 10, `101-2106` 10 against 5, `101-2112` 10 against 7.
   Re-running that lane at DSS 100 reproduces the first two exactly. The likely
   explanation is the 25-case pallet: Marco reached it by topping up SKUs that
   already had demand, where §6.1 reaches it by adding cases from a separate
   filler pool. Both get a full pallet; they load different SKUs. **This is the
   one worth settling before go-live**, because it changes what ships, not just
   how much.

3. **A discontinued SKU shipped to AWD.** `401-1020-S`, 2 cases. §6 excludes
   discontinued "no exceptions", so the script sends 0.

4. **`101-2040` cascades.** The script tops it to 100 DOI on the AWD lane (31
   cases against Marco's 20), which fully covers FBA and so closes the residual
   lane — where Marco also sent 4 cases from Tactical. One root cause, two
   rows of difference.

Rebuild `08-04-26`, `06-29-26` and `06-22-26` the same way before going live.

## What needs a decision

Four things are genuinely undecided. All four are config constants, so settling
them is a value change, not an edit.

1. **The pallet-fill ceiling** (§12, explicitly left open).
   `PALLET_FILL_MAX_AWD_DOI` defaults to 100 and
   `PALLET_FILL_MAX_CASES_PER_SKU` to 2. Both conservative. With only two
   eligible SKUs the second one caps the fill at 4 cases, and the run header
   reports the shortfall rather than shipping an under-full pallet.

2. **The Tactical floor source.** §2 says read `min. units at Tactical` from
   `14fW_-Gacy…` directly rather than through the planner's IMPORTRANGE. That
   workbook's tab layout could not be confirmed, so `MIN_UNITS.TAB` ships
   blank and the reader falls back to the planner's own column B — the same
   number by a longer route. The run header says which was used. Set
   `MIN_UNITS.TAB` and the direct read takes over; no code change.

3. **§7's quantity, which is stated twice and not identically.** "The smaller
   of (a) 1 case and (b) cases to reach the target" is a minimum; "1 case,
   unless more is needed to reach the target" is a maximum. The worked example
   is 4 cases, and Marco's real `101-2040` row is 4 cases where 4 were
   available, so the second reading is the default (`TAC_TO_FBA_QTY_MODE:
   'to_target'`). `'single_case'` gives the first.

4. **The Tactical → FBA spike ceiling.** §7 gate 4 says the resulting FBA DOI
   must not spike but gives no number. Pass 1 is the only worked example of how
   far an indivisible case may overshoot — 100 to 110 — so that 1.1 ratio is
   reused (`TAC_TO_FBA_SPIKE_MULTIPLIER`).

One reading in §7 is worth flagging because it changes behaviour sharply.
"Discontinued → 100 DOI cap, never exceed" is a *cap*, not a target — it is
the only one of the three phrased that way. Read as a target it pushes 205
units of a liquidating SKU into FBA on the 08-10 data, against Marco's 12. So
discontinued SKUs get the minimum viable quantity and a hard 100 DOI ceiling.

Also worth knowing: the 08-10 planner had `DSS` set to **50** on the AWD → FBA
tab, not the 60 the spec calls for. The spec wins by default; set
`RULES.DSS_BY_LANE.AWD_TO_FBA` to reproduce a past run.

## Not built

Phase 2, in the spec's order of value: the shipments-tracker upload, Tactical
WMS outbound orders, and Seller Central shipment creation. The `AWD TO FBA`
summary tab is deliberately narrow — SKU, case qty, units, cases — so it reads
straight down while typing into Seller Central by hand.
