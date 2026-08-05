/**
 * Recorded click paths.
 *
 * Prefer {role, name} over CSS chains. Role-based selectors survive Amazon's
 * redesigns; `div > div:nth-child(3) > span` does not.
 *
 * To re-record after a reskin:
 *     npm run record:na        # or record:eu
 * A signed-in browser opens and prints a selector for every click. Paste the
 * useful ones in here as extra candidates — leave the old ones in place, the
 * list is tried in order and costs nothing when the first entry still works.
 *
 * You can override this whole file without touching git by creating
 * src/selectors.local.js exporting the same shape (it is gitignored).
 */

export const INVENTORY = {
  /**
   * Report Central, FBA Manage Inventory. The report is generated
   * asynchronously: click Request, a row appears in the table below, and some
   * minutes later that row's status flips to a download link.
   */
  requestDownload: [
    { role: 'button', name: /request\s+\.?csv\s+download/i },
    { role: 'button', name: /request\s+\.?txt\s+download/i },
    { role: 'button', name: /request\s+download/i },
    { role: 'link', name: /request\s+\.?(csv|txt)\s+download/i },
    { role: 'button', name: /bericht\s+anfordern/i },     // DE
    { role: 'button', name: /demander\s+le\s+t.l.chargement/i }, // FR
  ],

  /** The table of previously requested reports. */
  reportTable: [
    { css: 'table:has(a[href*="download"])' },
    { css: '[data-testid="report-list"]' },
    { css: 'table' },
  ],

  /** A ready row's download link. Rows still generating have no link. */
  downloadLink: [
    { role: 'link', name: /^download$/i },
    { role: 'button', name: /^download$/i },
    { role: 'link', name: /herunterladen/i },
    { css: 'a[href*="downloadReport"]' },
    { css: 'a[download]' },
  ],

  /** Text that means "this row is not ready yet". */
  pendingText: [/in progress/i, /generating/i, /pending/i, /wird erstellt/i],
};

/**
 * Business Reports → Detail Page Sales and Traffic by Child Item.
 *
 * THIS IS THE PART THAT WAS NEVER RECORDED. The menu path genuinely differs
 * between US and EU, so NA and EU get separate entries below.
 *
 * `url` is tried first — if a direct URL loads the report with the dates
 * applied, no clicking is needed and the whole path becomes reskin-proof.
 * Tokens: {host} {start} {end} {startUs} {endUs}
 *
 * If `url` does not land on the report, `steps` are clicked in order. Record
 * them with `npm run record:na`, then paste them in as {role, name} entries.
 */
export const SALES = {
  NA: {
    url: [
      'https://{host}/business-reports/ref=xx_sitemetric_dnav_xx#/report'
        + '?reportType=DetailSalesTrafficByChildItem'
        + '&fromDate={start}&toDate={end}&dateRangeType=custom',
      'https://{host}/business-reports#/dashboard'
        + '?reportType=DetailSalesTrafficByChildItem&fromDate={start}&toDate={end}',
    ],
    steps: [
      // e.g. { role: 'link', name: 'Business Reports' },
      //      { role: 'link', name: 'Detail Page Sales and Traffic By Child Item' },
    ],
    dateRange: {
      openPicker: [
        { role: 'button', name: /date\s*(range|comparison)/i },
        { css: '#daterangepicker' },
      ],
      startInput: [{ label: /from|start/i }, { css: 'input[name="fromDate"]' }],
      endInput: [{ label: /to|end/i }, { css: 'input[name="toDate"]' }],
      apply: [{ role: 'button', name: /apply|update|refresh/i }],
    },
    download: [
      { role: 'button', name: /download\s*(csv)?/i },
      { role: 'link', name: /download\s*(csv)?/i },
      { css: 'button[data-testid="download-csv"]' },
    ],
    /**
     * Optional: if the page fetches its rows as JSON, name the endpoint here and
     * the bot will read the response directly instead of clicking Download.
     * Far more robust than the CSV path. Find it in DevTools → Network while
     * loading the report by hand.
     */
    jsonEndpoint: null, // e.g. /business-reports\/api\/.*childItem/i
  },

  EU: {
    url: [
      'https://{host}/business-reports/ref=xx_sitemetric_dnav_xx#/report'
        + '?reportType=DetailSalesTrafficByChildItem'
        + '&fromDate={start}&toDate={end}&dateRangeType=custom',
      'https://{host}/business-reports#/dashboard'
        + '?reportType=DetailSalesTrafficByChildItem&fromDate={start}&toDate={end}',
    ],
    steps: [
      // EU's menu path differs from NA's — record it separately.
    ],
    dateRange: {
      openPicker: [
        { role: 'button', name: /date\s*(range|comparison)|zeitraum|p.riode/i },
        { css: '#daterangepicker' },
      ],
      startInput: [{ label: /from|start|von|du/i }, { css: 'input[name="fromDate"]' }],
      endInput: [{ label: /to|end|bis|au/i }, { css: 'input[name="toDate"]' }],
      apply: [{ role: 'button', name: /apply|update|refresh|anwenden|appliquer/i }],
    },
    download: [
      { role: 'button', name: /download|herunterladen|t.l.charger|descargar|scarica/i },
      { role: 'link', name: /download|herunterladen|t.l.charger|descargar|scarica/i },
    ],
    jsonEndpoint: null,
  },
};

/** Table on the sales page, used to tell "loaded" from "still spinning". */
export const SALES_GRID = [
  { css: 'table:has(th)' },
  { css: '[role="grid"]' },
  { css: '[data-testid="business-report-table"]' },
];

/** True once at least one region's sales path has been recorded. */
export function salesRecorded(regionKey) {
  const cfg = SALES[regionKey];
  return Boolean(cfg && (cfg.url?.length || cfg.steps?.length));
}
