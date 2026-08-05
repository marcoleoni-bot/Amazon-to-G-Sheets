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

/**
 * How the evidence actually works.
 *
 * A suffix is a POSITIVE signal: "-CA" means this listing is Canadian. The
 * absence of a suffix signals nothing — legacy listings carry no suffix and
 * appear in every marketplace. A real Canadian file looks like this:
 *
 *     101-1015-V2-COM        legacy, no suffix
 *     101-1015-V2-COM-CA     same product, suffixed
 *
 * both rows, same file. An earlier rule required 80% of SKUs to carry the
 * expected suffix, which treated "no suffix" as evidence of the US and failed
 * that perfectly good file. So instead, two questions that the evidence can
 * genuinely answer:
 *
 *   1. Are another marketplace's SKUs in here?  → served the wrong file
 *   2. Is the expected suffix entirely absent?  → served the wrong file
 *
 * Unsuffixed rows are neutral to both. Contamination means a whole foreign
 * file, so it trips these decisively — the 132-row US file served for a CA
 * request had zero "-CA" SKUs and failed on question 2.
 */
const FOREIGN_TOLERANCE = Number(process.env.MARKETPLACE_FOREIGN_TOLERANCE || 0.05);

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
  const distribution = ranked.map(([k, v]) => `${k}=${v}`).join(', ');

  const UNSUFFIXED = 'US (no suffix)';
  const expectedCount = counts.get(expected) || 0;
  const foreign = ranked.filter(([cls]) =>
    cls !== expected && cls !== UNSUFFIXED && cls !== 'blank');
  const foreignCount = foreign.reduce((sum, [, n]) => sum + n, 0);
  const foreignShare = foreignCount / sample.length;
  const expectsSuffix = Boolean(MARKETPLACES[code].skuSuffix);

  // Show the actual SKUs. The suffix convention is a property of *this
  // account's* naming, not of Amazon, so a mismatch is as likely to mean the
  // convention was recorded wrong as it is to mean the file is the wrong one.
  // Counts alone cannot tell those apart; example SKUs can.
  const witness = ranked
    .map(([cls]) => `      ${cls}: ${examples.get(cls).join(', ')}`)
    .join('\n');

  // Question 1: are another marketplace's SKUs in this file?
  if (foreignShare > FOREIGN_TOLERANCE) {
    throw new MarketplaceMismatchError(code, {
      looksLike: foreign[0][0],
      detail: `${foreignCount}/${sample.length} sampled SKUs belong to another marketplace `
        + `(${foreign.map(([c, n]) => `${c}=${n}`).join(', ')}), above the `
        + `${(FOREIGN_TOLERANCE * 100).toFixed(0)}% tolerance.\n`
        + `    Distribution: ${distribution}\n    Example SKUs:\n${witness}\n`
        + '    Report Central served another marketplace\'s file.',
    });
  }

  // Question 2: is the expected suffix missing entirely?
  if (expectsSuffix && expectedCount === 0) {
    throw new MarketplaceMismatchError(code, {
      looksLike: 'a file with no {code} listings at all'.replace('{code}', code),
      detail: `not one of the ${sample.length} sampled SKUs carries the ${code} signal `
        + `("${MARKETPLACES[code].skuSuffix}").\n`
        + `    Distribution: ${distribution}\n    Example SKUs:\n${witness}\n`
        + `    A genuine ${code} file contains at least some suffixed listings alongside the\n`
        + '    unsuffixed legacy ones. None at all means another marketplace\'s file.\n'
        + `    If this account genuinely stopped using "${MARKETPLACES[code].skuSuffix}" for\n`
        + '    that marketplace, correct SKU_SIGNALS in src/verify-marketplace.js.',
    });
  }

  const unsuffixed = counts.get(UNSUFFIXED) || 0;
  const note = expectsSuffix
    ? `${expectedCount} SKU(s) carry the ${code} signal, ${unsuffixed} unsuffixed legacy, `
      + `no foreign suffixes${blockLevelOnly ? ' — EU pool, cannot distinguish from DE/FR/IT/ES' : ''}`
    : `no foreign suffixes among ${sample.length} sampled SKUs`;

  return {
    checked: true,
    blockLevelOnly,
    sampled: sample.length,
    expected,
    expectedCount,
    foreignCount,
    distribution,
    note,
  };
}
