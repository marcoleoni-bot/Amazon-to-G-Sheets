import { openRegion } from './browser.js';
import { fetchInventory } from './fetch-inventory.js';
import { fetchSales } from './fetch-sales.js';
import { marketplace, PULL_SPACING_MS } from './config.js';
import { sleep } from './dates.js';
import { log } from './log.js';

/**
 * Pulls are grouped by region so each region's browser session is opened once.
 * Within a region they run in sequence, spaced out: 25 downloads fired as fast
 * as the network allows is exactly the shape of traffic that gets throttled.
 */
export async function fetchAll(specs, { headless = true } = {}) {
  const byRegion = new Map();
  for (const spec of specs) {
    const region = marketplace(spec.marketplace).region;
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(spec);
  }

  const results = [];

  for (const [regionKey, regionSpecs] of byRegion) {
    log.info(`${regionKey}: ${regionSpecs.length} pull(s)`);
    const session = await openRegion(regionKey, { headless });
    try {
      for (const [i, spec] of regionSpecs.entries()) {
        const data = spec.kind === 'inventory'
          ? await fetchInventory(session.page, spec.marketplace)
          : await fetchSales(session.page, spec.marketplace, spec.days);
        results.push({ ...data, spec });

        if (i < regionSpecs.length - 1) await sleep(PULL_SPACING_MS);
      }
      // Refresh the stored cookies — Amazon rotates them as you browse, and
      // saving them back buys weeks of extra session life.
      await session.save().catch(() => {});
    } finally {
      await session.close();
    }
  }

  return results;
}
