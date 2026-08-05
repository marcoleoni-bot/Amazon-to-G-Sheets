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

/**
 * The SKU suffix each marketplace's listings carry.
 *
 * This is a property of THIS SELLER'S naming convention, not of Amazon, so it
 * is the first thing to correct if the marketplace check misfires. Longest
 * suffixes first, so "-UK1" is tested before any shorter match. Set
 * SKU_SIGNALS_JSON to override without editing code, e.g.
 *   SKU_SIGNALS_JSON='[{"suffix":"-UK","label":"UK"}]'
 */
export const SKU_SIGNALS = process.env.SKU_SIGNALS_JSON
  ? JSON.parse(process.env.SKU_SIGNALS_JSON)
  : [
  { suffix: '-UK1', label: 'UK' },
  { suffix: '-CA', label: 'CA' },
  { suffix: '-EU', label: 'EU-pool (DE/FR/IT/ES)' },
];

export function classifySku(sku) {
  const s = String(sku || '').trim();
  for (const { suffix, label } of SKU_SIGNALS) {
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
  const examples = new Map();
  for (const sku of sample) {
    const cls = classifySku(sku);
    counts.set(cls, (counts.get(cls) || 0) + 1);
    if (!examples.has(cls)) examples.set(cls, []);
    if (examples.get(cls).length < 3) examples.get(cls).push(sku);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topClass, topCount] = ranked[0];
  const share = topCount / sample.length;
  const distribution = ranked.map(([k, v]) => `${k}=${v}`).join(', ');

  // Show the actual SKUs. The suffix convention is a property of *this
  // account's* naming, not of Amazon, so a mismatch is as likely to mean the
  // convention was recorded wrong as it is to mean the file is the wrong one.
  // Counts alone cannot tell those apart; example SKUs can.
  const witness = ranked
    .map(([cls]) => `      ${cls}: ${examples.get(cls).join(', ')}`)
    .join('\n');

  if (topClass !== expected) {
    throw new MarketplaceMismatchError(code, {
      looksLike: topClass,
      detail: `${topCount}/${sample.length} sampled SKUs classify as "${topClass}", `
        + `expected "${expected}".\n    Distribution: ${distribution}\n    Example SKUs:\n${witness}\n`
        + '    Either Report Central served another marketplace\'s file, or this account\'s\n'
        + `    ${code} SKUs do not use the suffix this bot was told to expect — the example\n`
        + '    SKUs above will tell you which. To correct the convention, see SKU_SIGNALS\n'
        + '    in src/verify-marketplace.js.',
    });
  }

  if (share < DOMINANCE) {
    throw new MarketplaceMismatchError(code, {
      looksLike: 'a mixture',
      detail: `only ${(share * 100).toFixed(1)}% of sampled SKUs classify as "${expected}" `
        + `(threshold ${(DOMINANCE * 100).toFixed(0)}%).\n    Distribution: ${distribution}\n`
        + `    Example SKUs:\n${witness}`,
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
