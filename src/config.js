/**
 * Static configuration: marketplaces, regions, tab names, windows.
 *
 * Marketplace IDs carry the `amzn1.mp.o.` prefix on purpose. Switching
 * marketplace with the bare ID (ATVPDKIKX0DER) silently does nothing — the page
 * loads, the picker still shows the old marketplace, and you download the wrong
 * country's file with no error anywhere.
 */

export const SPREADSHEET_ID = process.env.SPREADSHEET_ID
  || '11MRJ34Ats11nW2myGMXDJApLPgav3TC1fGdjKmLD5FQ';

export const REGIONS = {
  NA: {
    key: 'NA',
    loginHost: 'sellercentral.amazon.com',
    statePath: '.state/na.json',
    // Merchant ID differs between NA and EU on the same account.
    merchantIdEnv: 'NA_MERCHANT_ID',
  },
  EU: {
    key: 'EU',
    loginHost: 'sellercentral.amazon.co.uk',
    statePath: '.state/eu.json',
    merchantIdEnv: 'EU_MERCHANT_ID',
  },
};

/**
 * skuSuffix is the contamination signal (gotcha #1). US SKUs carry no suffix,
 * which is why it is `null` rather than `''` — "no suffix" is a distinct state
 * from "some suffix we forgot to record".
 *
 * DE/FR/IT/ES all share `-EU` because they draw on one Pan-EU pool. That means
 * the SKU signal can prove "this file is European" but cannot prove "this file
 * is French". See verifyMarketplace() for how that gap is covered.
 */
export const MARKETPLACES = {
  US: { code: 'US', region: 'NA', host: 'sellercentral.amazon.com',   marketplaceId: 'amzn1.mp.o.ATVPDKIKX0DER',  skuSuffix: null },
  CA: { code: 'CA', region: 'NA', host: 'sellercentral.amazon.ca',    marketplaceId: 'amzn1.mp.o.A2EUQ1WTGCTBG2', skuSuffix: '-CA' },
  UK: { code: 'UK', region: 'EU', host: 'sellercentral.amazon.co.uk', marketplaceId: 'amzn1.mp.o.A1F83G8C2ARO7P', skuSuffix: '-UK1' },
  DE: { code: 'DE', region: 'EU', host: 'sellercentral.amazon.de',    marketplaceId: 'amzn1.mp.o.A1PA6795UKMFR9', skuSuffix: '-EU' },
  FR: { code: 'FR', region: 'EU', host: 'sellercentral.amazon.fr',    marketplaceId: 'amzn1.mp.o.A13V1IB3VIYZZH', skuSuffix: '-EU' },
  IT: { code: 'IT', region: 'EU', host: 'sellercentral.amazon.it',    marketplaceId: 'amzn1.mp.o.APJ6JRA9NG5V4',  skuSuffix: '-EU' },
  ES: { code: 'ES', region: 'EU', host: 'sellercentral.amazon.es',    marketplaceId: 'amzn1.mp.o.A1RKKUPIHCS9HS', skuSuffix: '-EU' },
};

/** Marketplaces whose SKU suffix is unique, and can therefore be told apart. */
export const DISTINGUISHABLE = ['US', 'CA', 'UK'];

/** Inventory: 4 pulls, 4 tabs, one marketplace each. */
export const INVENTORY_PULLS = [
  { marketplace: 'US', tab: 'US Inventory' },
  { marketplace: 'CA', tab: 'CA Inventory' },
  { marketplace: 'UK', tab: 'UK Inventory' },
  { marketplace: 'DE', tab: 'DE Inventory' },
];

export const WINDOWS = [7, 30, 90];

/**
 * Sales: 21 pulls (7 marketplaces x 3 windows) landing in 12 tabs.
 * The DE tab is DE + FR + IT + ES appended in that order — the sheet
 * aggregates by child ASIN downstream, so duplicate ASINs across the four
 * are expected and correct.
 */
export const SALES_TABS = [
  { tab: 'US Sales', marketplaces: ['US'] },
  { tab: 'CA Sales', marketplaces: ['CA'] },
  { tab: 'UK Sales', marketplaces: ['UK'] },
  { tab: 'DE Sales', marketplaces: ['DE', 'FR', 'IT', 'ES'] },
];

export const SALES_PULLS = SALES_TABS.flatMap(({ tab, marketplaces }) =>
  WINDOWS.flatMap((days) =>
    marketplaces.map((marketplace) => ({
      marketplace,
      days,
      tab: `${tab} ${days}`,
    }))));

/**
 * INCLUSIVE_END = true means a 7-day window is [today-6 .. today] — seven days
 * of data counting today. If your manual download actually yields
 * [today-7 .. today] (eight days), flip this. See README, "Day-one verification".
 */
export const INCLUSIVE_END = true;

export const FBA_INVENTORY_REPORT_PATH = '/reportcentral/FBA_MYI_UNSUPPRESSED_INVENTORY/1';

/** Amazon regenerates FBA reports roughly every 30 min; don't wait for a fresh one. */
export const REPORT_MAX_AGE_HOURS = Number(process.env.REPORT_MAX_AGE_HOURS || 26);

/** Spacing between pulls, to stay clear of throttling on a 25-download batch. */
export const PULL_SPACING_MS = Number(process.env.PULL_SPACING_MS || 4000);

export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'downloads';

export function marketplace(code) {
  const mp = MARKETPLACES[code];
  if (!mp) {
    throw new Error(`Unknown marketplace "${code}". Known: ${Object.keys(MARKETPLACES).join(', ')}`);
  }
  return mp;
}

export function regionOf(code) {
  return REGIONS[marketplace(code).region];
}

export function merchantId(code) {
  const region = regionOf(code);
  const id = process.env[region.merchantIdEnv];
  if (!id) {
    throw new Error(
      `${region.merchantIdEnv} is not set. Switch marketplace once in the browser and read `
      + `mons_sel_dir_mcid out of the URL — NA and EU have different merchant IDs.`);
  }
  return id;
}
