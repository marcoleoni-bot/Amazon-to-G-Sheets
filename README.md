# amazon-report-bot

A temporary bridge. It logs into Seller Central in a saved browser session, downloads the same reports you download by hand, and writes them into the sixteen raw tabs of *Copy of OPS Intelligence Hub* — preserving each tab's exact column layout so `Calc_Data` keeps working untouched.

Intended lifespan: about a month, until the tech team does the structural work. It is built to fail loudly and be easy to re-record, not to be elegant.

---

## Read this first: this is not the sanctioned path

Scraping Seller Central is outside Amazon's API terms. The supported route is **SP-API**, authorised once as a private app on your own seller account, and it removes three of the four things that will wake you up at night:

| | this bot | SP-API |
|---|---|---|
| Session expiry | every 2–4 weeks, manual re-login | never — refresh token |
| Needs a machine left awake | yes | no |
| Breaks when Amazon reskins | yes | no |
| Terms of service | outside them | sanctioned |
| Work to set up | done | ~a day, one-time |

The one-time authorisation is a single token. If this bot is still running in six weeks, that is the thing to fix — not the selectors.

It would also give you two figures you currently cannot see at all: AWD's `replenishmentQuantity` (units in transit from AWD to FBA), and restock recommendations.

---

## What it does

| Tab | Source |
|---|---|
| `US / CA / UK / DE Inventory` | FBA Manage Inventory report, one per marketplace |
| `US / CA / UK Sales {7,30,90}` | Detail Page Sales and Traffic by Child Item |
| `DE Sales {7,30,90}` | DE + FR + IT + ES, appended into one tab |

25 pulls per run (4 inventory + 21 sales) into 16 tabs. Row 1 of every tab is never touched.

## Setup

```bash
npm install                 # also installs Chromium
npm run login -- NA         # sign in by hand, tick "keep me signed in"
npm run login -- EU         # separate domain, separate session
```

Then Google credentials: create a service account, enable the Sheets API, download the key, and **share the spreadsheet with the service account's email address** (Editor).

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
export ALERT_WEBHOOK=https://n8n.operationautopilot.com/webhook/amazon-bot   # optional
```

**Merchant IDs.** NA and EU have different ones and both are needed.

The reliable way: in Seller Central, switch marketplace once (US → CA for NA, UK → DE for EU), then paste the **whole resulting URL**:

```bash
npm run whoami -- NA "https://sellercentral.amazon.com/...?mons_sel_dir_mcid=..."
npm run whoami -- EU "https://sellercentral.amazon.co.uk/...?mons_sel_dir_mcid=..."
```

It pulls out `mons_sel_dir_mcid` and `mons_sel_dir_paid`, ignores `mons_sel_mkid` (all seven marketplaces are already configured), and refuses a `.co.uk` URL recorded as NA. Paste the URL rather than picking one ID out of it by hand — it contains three opaque `amzn1.*` values that look alike, and choosing wrong produces no error, just the wrong account's data.

Or let it read them out of the saved sessions:

```bash
npm run whoami          # → .state/merchants.json
```

That path exists because Settings → Account Info → Merchant Token is gated to the primary account holder, so a secondary user cannot read their own ID from the UI. Environment variables `NA_MERCHANT_ID` / `EU_MERCHANT_ID` / `AMZN_PAID_ID` override the cache file if you'd rather set them that way.

Then:

```bash
npm run check               # preflight: sessions, IDs, baselines, tabs, date windows
```

`npm run check` tells you exactly what is still missing. It touches nothing.

## Commands

```bash
npm run login -- NA|EU              # manual sign-in, saves cookies only
npm run whoami                      # discover merchant tokens from the saved sessions
npm run check                       # preflight, writes nothing
npm run try -- inventory US         # one pull, validated, printed, not written
npm run try -- sales DE 30          # ditto; HEADED=1 to watch it
npm run baseline -- inventory US    # record/accept a schema baseline
npm start                           # full run: fetch all → validate all → write
npm test                            # unit tests, no network
npm run record:na                   # Playwright codegen, signed in
```

## The part you still have to do yourself

**The sales click path.** It is the one thing that was never recorded, and the menu path genuinely differs between US and EU. `src/selectors.js` ships with direct-URL guesses for both regions; if they work, nothing more is needed. If they don't, `npm run try -- sales US 30` fails with instructions rather than a stack trace.

```bash
npm run record:na
```

A browser opens, already signed in. Click your usual path — Reports → Business Reports → Detail Page Sales and Traffic by Child Item → custom date range → Download. Then fill in **one** of these in `src/selectors.js`:

1. `SALES.NA.jsonEndpoint` — a regex matching the XHR that returns the rows (DevTools → Network). **Best option.** Reading the JSON directly is immune to reskins, and the bot maps its fields into the right columns for you.
2. `SALES.NA.url` — the final URL, with `{start}` / `{end}` / `{host}` substituted in for the dates.
3. `SALES.NA.steps` — the clicks, as `{ role, name }` entries.

Repeat for `record:eu`. Prefer `getByRole('button', { name: '...' })` over CSS chains — role-based selectors survive Amazon's redesigns; `div > div:nth-child(3) > span` does not.

You can put overrides in `src/selectors.local.js` (gitignored, same shape) to fix a broken path without a commit.

## Day-one verification (do not skip)

Two things need one real download to confirm.

**1. The date window.** `INCLUSIVE_END = true` in `src/config.js` means a 7-day window is `[today-6 .. today]`. If your manual click actually yields `[today-7 .. today]`, flip it.

1. Download `US Sales 30` by hand, the way you always do. Keep the file.
2. `npm run try -- sales US 30`
3. Diff the `Units Ordered` column against your file.

Everything in `Calc_Data` — every velocity, every DOI, every purchase order — hangs off this. Twenty minutes, and the highest-value twenty minutes in this project.

**2. The schema baselines.** `schemas/inventory.NA.json` and `schemas/inventory.EU.json` ship marked `"provisional": true`. Positions 1–22 (NA) and 1–24 (EU) are pinned by the layout `Calc_Data` already depends on; the last two columns of each are reconstructed. Confirm them against a real download:

```bash
npm run try -- inventory US     # prints the header with column letters
npm run baseline -- inventory US
npm run baseline -- inventory UK
```

There is no sales baseline shipped at all — nobody has seen that header yet. Record it with `npm run baseline -- sales US 30` once the click path works. Until then `npm start` will refuse to write, which is correct.

## The schema guard

`src/guard.js` refuses to write if a report's header row changes shape — added, removed, renamed, or reordered columns. It reports the exact position, expected vs actual:

```
Schema changed for US inventory:
  baseline has 24 columns, report has 25

  position 23/W  expected "afn-fc-processing-quantity"
                 actual   "afn-inbound-transfer-quantity"
  added:   "afn-inbound-transfer-quantity" at 23/W
  moved:   "afn-fc-processing-quantity" 23/W → 24/X, "store" 24/X → 25/Y
```

This is not paranoia. Openbridge's `amazon_inventory_history` table is missing `afn-fc-transfer-quantity`, so units in transit between fulfillment centers were silently dropped — 91 of 137 US SKUs currently have stock in that state. Nothing errored. It just quietly disappeared, for months.

`Calc_Data` reads columns by *letter* (`select 'UK', A, C, K, M, P, Q, R, X`), and the column of interest sits at **V** in US/CA but **X** in UK/DE, because Europe's report inserts `afn-fulfillable-quantity-local` and `-remote` at positions 22–23. If Amazon appends one more column, or you "helpfully" normalise the layout, the QUERY reads the wrong column and returns plausible numbers with no error at all.

So: the bot writes the raw inventory file, positionally, per region. It does not clean anything up.

The **sales** tabs are the exception, and deliberately so. They are rebuilt by column *name* into fixed positions, because `Calc_Data`'s `SUMIF` requires child ASIN in **B** and Units Ordered in **N**. `src/sales-layout.js` owns that mapping and throws at startup if either position is disturbed. The guard still fires on any source change — you want to know — but the output stays correct regardless of how Amazon orders its export.

**Related fix, worth doing regardless of this bot:** `Calc_Data` reads `'US Inventory'!A2:X1000` and `'UK Inventory'!A2:Z1000` — exactly today's column counts. Widen both to `A2:AZ1000`.

## Marketplace contamination

The single most important safeguard. Switching marketplace by URL parameter works — the page changes, the picker updates — but Report Central sometimes serves the *previously* selected marketplace's file anyway. Nothing errors. You get a complete, well-formed report for the wrong country, in the right tab.

Two checks, before anything is trusted:

1. **Page level.** The active marketplace is read back off the page before the download is requested. Contradicting evidence aborts; no evidence warns.
2. **File level.** SKU suffixes on the downloaded rows: `-UK1` = UK, `-CA` = CA, `-EU` = the European pool, no suffix = US. At least 80% must agree with what was requested, or the run stops.

Honest limit: DE, FR, IT and ES all share `-EU` because they draw on one Pan-EU pool, so the file-level check proves a file is European but not that it is German. Within that block only check 1 applies, and the run tells you when a pull was verified at block level only.

Marketplace IDs carry the `amzn1.mp.o.` prefix. Without it, switching silently no-ops — the most expensive five characters in this repo.

## Two phases

Everything is fetched and validated before anything is written. A run that writes eight tabs and then hits a changed column leaves the sheet half old and half new, and `Calc_Data` averages across both without complaint. Better to write nothing and say why — which is what it does, exiting non-zero.

## Scheduling

```cron
MAILTO=you@company.com
30 5 * * *  cd /opt/amazon-report-bot && /usr/bin/node src/index.js >> run.log 2>&1
```

Run it on a machine that stays awake. If you put it in n8n, use an Execute Command node rather than trying to drive Playwright from a Code node — n8n's sandbox doesn't have a browser.

A full run takes roughly 20–40 minutes: 25 pulls, spaced out on purpose. Amazon regenerates FBA reports about every 30 minutes and throttles requests for more, so the bot takes the newest ready report rather than forcing a fresh one, and relies on the marketplace check for correctness.

## What will break, and when

- **The session dies.** Amazon invalidates it every few weeks. The bot detects the `/ap/signin` redirect, alerts, exits non-zero, and writes nothing. Run `npm run login` again. Expect this monthly.
- **Selectors rot.** Amazon reskins Seller Central without notice. Re-record. Budget an hour a month.
- **CAPTCHA.** If headless Chrome starts getting challenged, the honest answer is that you've lost. Don't escalate into a stealth-plugin arms race; that's the signal to go get the SP-API token.
- **A new column.** The guard catches it and refuses to write. That's the guard working.

## Two things this cannot do

**AWD.** Amazon Warehousing and Distribution lives on a different page with a different export. Your `WR_available` figures still need the manual import.

**Anything new.** Restock recommendations, inbound shipment tracking, hourly inventory notifications — none of it has a page to scrape. Each would be another scraper.

That's the trade. It was made knowingly, and for a month it's a fine one.
