import * as base from './selectors.js';

/**
 * src/selectors.local.js (gitignored) wins over src/selectors.js if present, so
 * a freshly recorded path can be dropped in mid-incident without a commit.
 */
let local = {};
try {
  local = await import('./selectors.local.js');
} catch {
  // no local override — normal case
}

export const INVENTORY = local.INVENTORY ?? base.INVENTORY;
export const SALES = local.SALES ?? base.SALES;
export const SALES_GRID = local.SALES_GRID ?? base.SALES_GRID;
export const usingLocalOverride = Object.keys(local).length > 0;
