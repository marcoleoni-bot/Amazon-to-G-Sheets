import { fetchAll } from './runner.js';
import { validateSchema, columnLetter } from './guard.js';
import { planMapping, mapRows, SALES_COLUMNS } from './sales-layout.js';
import { marketplace } from './config.js';
import { log, heading } from './log.js';

/**
 * One pull, validated and printed, never written.
 *
 *   npm run try -- inventory US
 *   npm run try -- sales DE 30
 *   HEADED=1 npm run try -- sales US 7      # watch it happen
 */

const [kind, code, daysArg] = process.argv.slice(2);
const usage = 'Usage: npm run try -- inventory US   |   npm run try -- sales DE 30';

if (!['inventory', 'sales'].includes(kind) || !code) {
  console.error(usage);
  process.exit(2);
}
const days = kind === 'sales' ? Number(daysArg || 30) : undefined;
if (kind === 'sales' && ![7, 30, 90].includes(days)) {
  console.error(`Sales window must be 7, 30 or 90.\n${usage}`);
  process.exit(2);
}

const mp = marketplace(code.toUpperCase());

try {
  const [result] = await fetchAll(
    [{ kind, marketplace: mp.code, days }],
    { headless: !process.env.HEADED });

  heading('Header as downloaded');
  result.header.forEach((h, i) => {
    console.log(`  ${String(i + 1).padStart(2)} ${columnLetter(i + 1).padEnd(3)} ${h}`);
  });

  heading('Marketplace check');
  console.log(`  ${result.marketplaceCheck.note}`);
  if (result.marketplaceCheck.distribution) {
    console.log(`  distribution: ${result.marketplaceCheck.distribution}`);
  }
  console.log(`  page-level:   ${result.activeMarketplaceCheck?.how || 'not checked'}`);

  heading('Schema guard');
  try {
    const { key, baseline } = validateSchema({
      kind, mp, header: result.header, label: `${code} ${kind}`,
    });
    log.ok(`matches baseline "${key}"${baseline.provisional ? ' (provisional)' : ''}`);
  } catch (err) {
    log.fail(err.message);
  }

  if (kind === 'sales') {
    heading('Positional mapping');
    const { plan, missing } = planMapping(result.header);
    SALES_COLUMNS.forEach((col, i) => {
      const src = plan[i] === -1 ? '(blank)' : `← "${result.header[plan[i]]}"`;
      const flag = i === 1 || i === 13 ? '  ←← contractual' : '';
      console.log(`  ${columnLetter(i + 1).padEnd(3)} ${col.name.padEnd(38)} ${src}${flag}`);
    });
    if (missing.length) log.warn(`blank padding columns: ${missing.join(', ')}`);
    result.rows = mapRows(result.rows, plan);
  }

  heading(`First 3 rows of ${result.rows.length}`);
  for (const row of result.rows.slice(0, 3)) {
    console.log(`  ${row.slice(0, 8).map((c) => String(c).slice(0, 18)).join(' | ')} …`);
  }

  log.blank();
  log.info('Nothing was written to the spreadsheet.');
} catch (err) {
  log.blank();
  log.fail(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
