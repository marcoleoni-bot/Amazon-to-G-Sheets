import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { REGIONS, MERCHANT_CACHE } from './config.js';
import { openRegion, gotoWithRetry } from './browser.js';
import {
  discoverMerchantId, isPlaceholder, looksLikeToken, isMarketplaceId,
  parseSwitchUrl, looksLikePaid,
} from './merchant-id.js';
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
const manual = process.argv[3];
const regions = only ? [only] : Object.keys(REGIONS);

if (only && !REGIONS[only]) {
  console.error('Usage: npm run whoami [-- NA|EU [token]]');
  process.exit(2);
}

const found = existsSync(MERCHANT_CACHE)
  ? JSON.parse(readFileSync(MERCHANT_CACHE, 'utf8'))
  : {};
let problems = 0;

// Manual route. Accepts either a bare ID or a whole switch URL:
//   npm run whoami -- NA "https://sellercentral.amazon.com/...?mons_sel_dir_mcid=..."
//   npm run whoami -- NA amzn1.merchant.d.YOURMERCHANTIDHERE
if (manual) {
  const parsed = parseSwitchUrl(manual);

  if (parsed) {
    if (!parsed.mcid) {
      log.fail('that URL has no mons_sel_dir_mcid parameter.');
      log.info('Switch marketplace in the browser first — the parameter only appears in the');
      log.info('URL the switch produces, not on a page you navigated to directly.');
      process.exit(2);
    }

    // A .co.uk URL recorded as NA would poison every North American pull.
    const euHost = /amazon\.(co\.uk|de|fr|it|es)$/.test(parsed.host);
    const expectedEu = only === 'EU';
    if (euHost !== expectedEu) {
      log.fail(`that is ${euHost ? 'an EU' : 'a North American'} URL (${parsed.host}), `
        + `but you are recording ${only}.`);
      process.exit(2);
    }

    found[only] = parsed.mcid;
    if (parsed.paid && looksLikePaid(parsed.paid)) found.paid = parsed.paid;

    mkdirSync(dirname(MERCHANT_CACHE), { recursive: true });
    writeFileSync(MERCHANT_CACHE, `${JSON.stringify(found, null, 2)}\n`);

    log.ok(`Recorded ${only} merchant ID ${parsed.mcid}`);
    if (found.paid) log.ok(`Recorded mons_sel_dir_paid ${found.paid} (shared by both regions)`);
    if (parsed.mkid) log.info(`(the marketplace in that URL was ${parsed.mkid} — not needed, `
      + 'all seven are already configured)');
    process.exit(0);
  }

  if (isMarketplaceId(manual)) {
    log.fail(`"${manual}" is a marketplace ID, not a merchant ID.`);
    log.info('They sit next to each other in the same URL and look alike:');
    log.info('  mons_sel_mkid=amzn1.mp.o.…       ← marketplace (already configured)');
    log.info('  mons_sel_dir_mcid=amzn1.merchant.d.…  ← merchant (what is needed here)');
    process.exit(2);
  }
  if (isPlaceholder(manual) || !looksLikeToken(manual)) {
    log.fail(`"${manual}" is not a merchant ID. Expected either `
      + 'amzn1.merchant.d.EXAMPLEMERCHANTIDFORTESTS (current form) '
      + 'or A2K8LM3PQ9WXYZ (legacy form).');
    process.exit(2);
  }
  found[only] = manual;
  mkdirSync(dirname(MERCHANT_CACHE), { recursive: true });
  writeFileSync(MERCHANT_CACHE, `${JSON.stringify(found, null, 2)}\n`);
  log.ok(`Recorded ${only} merchant token ${manual} → ${MERCHANT_CACHE}`);
  process.exit(0);
}

for (const regionKey of regions) {
  const region = REGIONS[regionKey];
  heading(`${regionKey} — ${region.loginHost}`);

  let session;
  try {
    session = await openRegion(regionKey, { headless: !process.env.HEADED });
    await gotoWithRetry(session.page, `https://${region.loginHost}/home`);

    const { candidates, signedOut } = await discoverMerchantId(session.page, region.loginHost);

    if (!candidates.length) {
      problems += 1;
      if (signedOut) {
        log.fail('this session is signed out — the page rendered a sign-in screen without '
          + `redirecting to /ap/signin. Run:  npm run login -- ${regionKey}`);
      } else {
        log.fail('signed in, but no merchant token found in the page markup');
        log.info('Two ways forward:');
        log.info(`  1. HEADED=1 npm run whoami -- ${regionKey}   (watch what the page shows)`);
        log.info('  2. Switch marketplace once in your own browser, copy mons_sel_dir_mcid');
        log.info(`     out of the address bar, then:  npm run whoami -- ${regionKey} <token>`);
      }
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
