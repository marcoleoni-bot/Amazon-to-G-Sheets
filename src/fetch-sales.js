import { marketplace, merchantId } from './config.js';
import {
  gotoWithRetry, withMarketplace, assertActiveMarketplace, captureDownload, assertSignedIn,
} from './browser.js';
import { SALES, SALES_GRID } from './selectors-loader.js';
import { findFirst, clickFirst } from './locate.js';
import { parseReport } from './parse.js';
import { verifyMarketplace } from './verify-marketplace.js';
import { windowFor, toUsFormat, sleep } from './dates.js';
import { NotRecordedError } from './errors.js';
import { log } from './log.js';

/**
 * Business Reports → Detail Page Sales and Traffic by Child Item.
 *
 * Three routes are tried, cheapest and most durable first:
 *
 *   1. jsonEndpoint — read the rows straight off the XHR the page already makes.
 *      Immune to reskins. Requires one look in DevTools to record the URL.
 *   2. url         — a direct link with the dates baked in, then click Download.
 *   3. steps       — click the menu path by hand, set the dates, click Download.
 *
 * Routes 2 and 3 need recording per region: the NA and EU menu paths differ.
 */

function fillTokens(template, { mp, range }) {
  return template
    .replace(/\{host\}/g, mp.host)
    .replace(/\{start\}/g, range.start)
    .replace(/\{end\}/g, range.end)
    .replace(/\{startUs\}/g, toUsFormat(range.start))
    .replace(/\{endUs\}/g, toUsFormat(range.end))
    .replace(/\{merchantId\}/g, merchantId(mp.code))
    .replace(/\{marketplaceId\}/g, mp.marketplaceId);
}

function decorate(url, mp) {
  // Keep the marketplace switch params on whatever URL we were handed, without
  // disturbing the hash-routed part the business reports SPA uses.
  const [base, hash] = url.split('#');
  const decorated = withMarketplace(mp, base.replace(`https://${mp.host}`, '') || '/');
  return hash ? `${decorated}#${hash}` : decorated;
}

async function gridVisible(page, timeout = 30_000) {
  return Boolean(await findFirst(page, SALES_GRID, { timeout }));
}

/** Pull the first array-of-objects out of an arbitrary JSON payload. */
export function rowsFromJson(payload) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      const objects = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objects.length >= 1 && Object.keys(objects[0]).length >= 3) return objects;
      for (const child of node) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    }
    for (const value of Object.values(node)) {
      const hit = walk(value);
      if (hit) return hit;
    }
    return null;
  };

  const objects = walk(payload);
  if (!objects) throw new Error('Could not find a row array in the JSON response.');

  const header = [...objects.reduce((set, o) => {
    Object.keys(o).forEach((k) => set.add(k));
    return set;
  }, new Set())];

  const flatten = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return v.amount ?? v.value ?? JSON.stringify(v);
    return v;
  };

  return { header, rows: objects.map((o) => header.map((k) => flatten(o[k]))) };
}

async function viaJsonEndpoint(page, cfg, url, mp) {
  const pattern = cfg.jsonEndpoint;
  const waiting = page.waitForResponse(
    (res) => pattern.test(res.url()) && res.status() === 200,
    { timeout: 120_000 });

  await gotoWithRetry(page, url);
  const res = await waiting;
  const payload = await res.json();
  const { header, rows } = rowsFromJson(payload);
  return { header, rows, delimiter: 'json', route: 'jsonEndpoint' };
}

async function viaDirectUrl(page, cfg, mp, range) {
  for (const template of cfg.url || []) {
    const url = decorate(fillTokens(template, { mp, range }), mp);
    try {
      await gotoWithRetry(page, url);
      if (await gridVisible(page)) return { url, route: 'url' };
      log.warn(`sales: ${url.split('#')[1] || url} loaded but no report grid appeared`);
    } catch (err) {
      if (err.name === 'SessionExpiredError') throw err;
      log.warn(`sales: direct URL failed (${err.message.split('\n')[0]})`);
    }
  }
  return null;
}

async function viaSteps(page, cfg, mp, range) {
  if (!cfg.steps?.length) return null;

  await gotoWithRetry(page, withMarketplace(mp, '/home'));
  for (const step of cfg.steps) {
    await clickFirst(page, [step], { what: `sales menu step ${JSON.stringify(step)}` });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const dr = cfg.dateRange || {};
  if (dr.openPicker) {
    const picker = await findFirst(page, dr.openPicker, { timeout: 10_000 });
    if (picker) await picker.locator.click();
  }
  for (const [key, value] of [['startInput', range.start], ['endInput', range.end]]) {
    if (!dr[key]) continue;
    const field = await findFirst(page, dr[key], { timeout: 10_000 });
    if (field) {
      await field.locator.fill('');
      await field.locator.type(toUsFormat(value));
    }
  }
  if (dr.apply) {
    const apply = await findFirst(page, dr.apply, { timeout: 10_000 });
    if (apply) await apply.locator.click();
  }

  await sleep(3000);
  if (await gridVisible(page)) return { url: page.url(), route: 'steps' };
  return null;
}

export async function fetchSales(page, code, days) {
  const mp = marketplace(code);
  const cfg = SALES[mp.region];
  const range = windowFor(days);

  log.step(`${code} sales ${days}d — ${range.start} .. ${range.end}`);

  let result;

  if (cfg.jsonEndpoint && cfg.url?.length) {
    const url = decorate(fillTokens(cfg.url[0], { mp, range }), mp);
    result = await viaJsonEndpoint(page, cfg, url, mp);
    await assertSignedIn(page);
  } else {
    const landed = (await viaDirectUrl(page, cfg, mp, range))
      || (await viaSteps(page, cfg, mp, range));

    if (!landed) {
      throw new NotRecordedError(
        `The ${mp.region} sales click path`,
        '  Neither the direct URL nor a recorded menu path reached the report.\n'
        + `  Record it once — it takes about ten minutes:\n\n`
        + `    npm run record:${mp.region.toLowerCase()}\n\n`
        + '  Click: Reports → Business Reports → Detail Page Sales and Traffic by Child\n'
        + '  Item, set a custom date range, click Download. Playwright prints a selector\n'
        + '  for every click. Then either:\n'
        + `    • paste the final URL into SALES.${mp.region}.url in src/selectors.js\n`
        + `      (tokens: {host} {start} {end} {startUs} {endUs}), or\n`
        + `    • paste the clicks into SALES.${mp.region}.steps as {role, name} entries.\n\n`
        + '  Best of all: open DevTools → Network while the report loads, find the XHR\n'
        + `  that returns the rows, and put its URL pattern in SALES.${mp.region}.jsonEndpoint.\n`
        + '  That route survives reskins entirely.');
    }

    const active = await assertActiveMarketplace(page, mp);
    if (!active.confirmed) {
      log.warn(`${code}: could not confirm the active marketplace (${active.how})`);
    }

    const { buffer } = await captureDownload(page, async () => {
      await clickFirst(page, cfg.download, { what: `the ${mp.region} sales Download button` });
    });
    result = { ...parseReport(buffer), route: landed.route };
    result.activeMarketplaceCheck = active;
  }

  const check = verifyMarketplace({ code, header: result.header, rows: result.rows });

  log.ok(`${code} sales ${days}d — ${result.rows.length} rows via ${result.route}; ${check.note}`);

  return {
    kind: 'sales',
    code,
    mp,
    days,
    range,
    header: result.header,
    rows: result.rows,
    delimiter: result.delimiter,
    route: result.route,
    marketplaceCheck: check,
    activeMarketplaceCheck: result.activeMarketplaceCheck ?? { confirmed: false, how: 'n/a' },
  };
}
