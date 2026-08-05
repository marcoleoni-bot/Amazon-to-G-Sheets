import { MARKETPLACES, DISTINGUISHABLE } from './config.js';
import { MarketplaceMismatchError } from './errors.js';
import { columnIndex } from './parse.js';

/**
 * The single most important safeguard in this bot.
 *
 * Switching marketplace by URL parameter works — the page changes, the picker
 * updates — but Report Central sometimes serves the *previously* selected
 * marketplace's generated file anyway. Nothing errors. You get a complete,
 * well-formed inventory report for the wrong country, and it lands in the right
 * tab. Every downstream number is then wrong in a way no one would spot.
 *
 * So the file has to prove which marketplace it belongs to before it is trusted.
 */

/** Fraction of rows that must agree with the requested marketplace. */
const DOMINANCE = Number(process.env.MARKETPLACE_DOMINANCE || 0.8);

/** Longest suffixes first, so "-UK1" is tested before any shorter match. */
const SIGNALS = [
  { suffix: '-UK1', label: 'UK' },
  { suffix: '-CA', label: 'CA' },
  { suffix: '-EU', label: 'EU-pool (DE/FR/IT/ES)' },
];

export function classifySku(sku) {
  const s = String(sku || '').trim();
  for (const { suffix, label } of SIGNALS) {
    if (s.toUpperCase().endsWith(suffix)) return label;
  }
  return s ? 'US (no suffix)' : 'blank';
}

/** What a given marketplace's SKUs should classify as. */
export function expectedClass(code) {
  const mp = MARKETPLACES[code];
  if (!mp.skuSuffix) return 'US (no suffix)';
  if (mp.skuSuffix === '-EU') return 'EU-pool (DE/FR/IT/ES)';
  return mp.code;
}

function findSkuColumn(header) {
  for (const name of ['sku', 'SKU', 'seller-sku', 'merchant-sku']) {
    const i = columnIndex(header, name);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Throws MarketplaceMismatchError if the file looks like it came from somewhere
 * else. Returns a summary otherwise.
 *
 * Note the honest limit: DE, FR, IT and ES all share the `-EU` suffix because
 * they draw on one Pan-EU pool, so this check proves a file is European but not
 * that it is German. Within that block the guarantee comes from
 * assertActiveMarketplace() in browser.js, which reads the marketplace back off
 * the page *before* the download is requested.
 */
export function verifyMarketplace({ code, header, rows, sampleSize = 400 }) {
  const skuCol = findSkuColumn(header);
  const expected = expectedClass(code);
  const blockLevelOnly = !DISTINGUISHABLE.includes(code);

  if (skuCol < 0) {
    return {
      checked: false,
      blockLevelOnly,
      note: 'no SKU column in this report — relying on the pre-download marketplace assertion alone',
    };
  }

  const sample = rows.slice(0, sampleSize)
    .map((r) => r[skuCol])
    .filter((s) => String(s || '').trim() !== '');

  if (!sample.length) {
    return { checked: false, blockLevelOnly, note: 'no SKUs in the sampled rows' };
  }

  const counts = new Map();
  for (const sku of sample) {
    const cls = classifySku(sku);
    counts.set(cls, (counts.get(cls) || 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topClass, topCount] = ranked[0];
  const share = topCount / sample.length;
  const distribution = ranked.map(([k, v]) => `${k}=${v}`).join(', ');

  if (topClass !== expected) {
    throw new MarketplaceMismatchError(code, {
      looksLike: topClass,
      detail: `${topCount}/${sample.length} sampled SKUs classify as "${topClass}", `
        + `expected "${expected}". Distribution: ${distribution}. `
        + 'Report Central almost certainly served the previously selected marketplace.',
    });
  }

  if (share < DOMINANCE) {
    throw new MarketplaceMismatchError(code, {
      looksLike: 'a mixture',
      detail: `only ${(share * 100).toFixed(1)}% of sampled SKUs classify as "${expected}" `
        + `(threshold ${(DOMINANCE * 100).toFixed(0)}%). Distribution: ${distribution}. `
        + 'A mixed file usually means a stale download was reused.',
    });
  }

  return {
    checked: true,
    blockLevelOnly,
    sampled: sample.length,
    share,
    expected,
    distribution,
    note: blockLevelOnly
      ? `matches the EU pool, which cannot distinguish ${code} from DE/FR/IT/ES by SKU`
      : `${(share * 100).toFixed(1)}% of SKUs carry the ${code} signal`,
  };
}
