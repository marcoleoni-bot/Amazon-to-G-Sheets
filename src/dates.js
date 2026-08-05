import { INCLUSIVE_END } from './config.js';

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Build the date range for an N-day sales window ending today.
 *
 * With INCLUSIVE_END = true, 7 days is [today-6 .. today] — today counts as one
 * of the seven. With it false, 7 days is [today-7 .. today], which is eight
 * calendar days but matches how some of Seller Central's presets behave.
 *
 * This is the one constant that cannot be verified without a real account, and
 * every velocity and DOI figure downstream hangs off it.
 */
export function windowFor(days, today = new Date()) {
  const end = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (INCLUSIVE_END ? days - 1 : days));
  return { start: iso(start), end: iso(end), days };
}

/** Seller Central's business report URLs want MM/DD/YYYY regardless of locale. */
export function toUsFormat(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
