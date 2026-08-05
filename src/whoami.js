import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { REGIONS, MERCHANT_CACHE } from './config.js';
import { openRegion, gotoWithRetry } from './browser.js';
import { discoverMerchantId } from './merchant-id.js';
import { log, heading } from './log.js';

/**
 * Read the merchant token out of the saved session, for people who cannot open
 * Settings → Account Info (it is gated to the primary account holder).
 *
 *   npm run whoami            # both regions
 *   npm run whoami -- NA      # one
 *   HEADED=1 npm run whoami   # watch it
 *
 * Writes .state/merchants.json, which config.js reads when the environment
 * variables are unset. Nothing is sent anywhere; the token stays on this
 * machine, in the same gitignored directory as the cookies.
 */

const only = (process.argv[2] || '').toUpperCase();
const regions = only ? [only] : Object.keys(REGIONS);

if (only && !REGIONS[only]) {
  console.error('Usage: npm run whoami [-- NA|EU]');
  process.exit(2);
}

const found = existsSync(MERCHANT_CACHE)
  ? JSON.parse(readFileSync(MERCHANT_CACHE, 'utf8'))
  : {};
let problems = 0;

for (const regionKey of regions) {
  const region = REGIONS[regionKey];
  heading(`${regionKey} — ${region.loginHost}`);

  let session;
  try {
    session = await openRegion(regionKey, { headless: !process.env.HEADED });
    await gotoWithRetry(session.page, `https://${region.loginHost}/home`);

    const { candidates } = await discoverMerchantId(session.page, region.loginHost);

    if (!candidates.length) {
      problems += 1;
      log.fail('no merchant token found on the signed-in page');
      log.info('Fall back to the manual route: switch marketplace once in the browser and');
      log.info('read mons_sel_dir_mcid out of the address bar.');
      continue;
    }

    for (const [i, c] of candidates.entries()) {
      const marker = i === 0 ? '✓' : ' ';
      console.log(`  ${marker} ${c.token}   (seen in: ${c.sources.join(', ')})`);
    }

    if (candidates.length > 1) {
      log.warn('more than one candidate — the first is the most corroborated, but if a run '
        + 'later fails the marketplace check, try the next one');
    }

    found[regionKey] = candidates[0].token;
  } catch (err) {
    problems += 1;
    log.fail(err.message);
  } finally {
    await session?.close();
  }
}

if (found.NA && found.EU && found.NA === found.EU) {
  log.blank();
  log.warn('NA and EU resolved to the same token. That is unusual — they normally differ. '
    + 'If marketplace switching misbehaves, get the EU one manually from '
    + 'sellercentral.amazon.co.uk.');
}

if (Object.keys(found).length) {
  writeFileSync(MERCHANT_CACHE, `${JSON.stringify(found, null, 2)}\n`);
  log.blank();
  log.ok(`Wrote ${MERCHANT_CACHE} — no environment variables needed now.`);
  log.info('If you had placeholder exports in ~/.zshrc, delete those lines; a set '
    + 'environment variable overrides this file.');
}

process.exit(problems ? 1 : 0);
