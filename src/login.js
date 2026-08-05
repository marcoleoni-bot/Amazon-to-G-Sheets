import readline from 'node:readline';
import { REGIONS } from './config.js';
import { openRegion } from './browser.js';
import { sleep } from './dates.js';
import { log, heading } from './log.js';

/**
 * Manual sign-in, once per region, saving cookies to .state/.
 *
 * No password and no MFA seed is stored anywhere — only the session cookies
 * Amazon hands back, which is the same thing your browser keeps.
 */

const regionKey = (process.argv[2] || '').toUpperCase();

if (!REGIONS[regionKey]) {
  console.error('Usage: npm run login -- NA|EU');
  process.exit(2);
}

const region = REGIONS[regionKey];

heading(`Sign in to ${regionKey} (${region.loginHost})`);
console.log(`
  A browser window is opening. Sign in the way you normally would, and tick
  "Keep me signed in" — without it the cookies expire in hours instead of weeks.

  Complete any MFA prompt. Once you can see Seller Central's home page, this
  will save the session automatically. Press Enter here to save immediately.
`);

const session = await openRegion(regionKey, { headless: false });

await session.page.goto(`https://${region.loginHost}/home`, { waitUntil: 'domcontentloaded' })
  .catch(() => {});

const enterPressed = new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('', () => { rl.close(); resolve('enter'); });
});

const signedIn = (async () => {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const url = session.page.url();
    const onSignin = url.includes('/ap/signin') || url.includes('/ap/mfa');
    if (!onSignin && url.includes(region.loginHost)) {
      // Give the page a moment to finish setting post-login cookies.
      await sleep(4000);
      return 'auto';
    }
  }
  return 'timeout';
})();

const how = await Promise.race([enterPressed, signedIn]);

if (how === 'timeout') {
  log.fail('Timed out after 20 minutes without reaching a signed-in page.');
  await session.close();
  process.exit(1);
}

await session.save();
log.ok(`Saved ${regionKey} session to ${region.statePath} (${how === 'enter' ? 'manual' : 'auto-detected'})`);
console.log(`
  Verify it works headlessly:   npm run check
  Expect to redo this roughly monthly — Amazon expires the session every 2-4 weeks.
`);

await session.close();
process.exit(0);
