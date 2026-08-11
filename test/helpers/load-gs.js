import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Loads the Apps Script sources into one sandbox and hands back its globals.
 *
 * Apps Script concatenates every .gs file into a single global scope, so this
 * mirrors it: one context, every file evaluated into it, cross-file calls
 * resolved at call time. That means the tests exercise the code that actually
 * ships rather than a Node-flavoured copy of it, and a syntax error in any file
 * fails the suite instead of waiting to be discovered in the editor.
 *
 * The Apps Script services are deliberately absent. Everything reachable from
 * here is pure, and anything that reaches for SpreadsheetApp is meant to fail
 * loudly in a test rather than pretend to work.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const GS_DIR = join(HERE, '..', '..', 'apps-script');

export function loadAppsScript() {
  const sandbox = { console, Date, Math, JSON, isFinite, isNaN, Number, String,
    Object, Array, Boolean, RegExp, Error };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const files = readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).sort();
  for (const file of files) {
    const code = readFileSync(join(GS_DIR, file), 'utf8');
    try {
      new vm.Script(code, { filename: file }).runInContext(context);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }
  return { context, files };
}

/** A row as readPlanningInput() would have built it, with sane defaults. */
export function awdFbaRow(over = {}) {
  return {
    rowIndex: 8,
    sku: 'TEST-1',
    b2b: false,
    critical: false,
    rate: 10,
    lifecycle: 'Stable',
    awdAvailableUnits: 1000,
    availableCases: 50,
    awdDoi: 100,
    amzFulfillable: 600,
    amzReserved: 0,
    amzInbound: 0,
    amzTotal: 600,
    amzDoi: 60,
    caseQty: 20,
    ...over,
  };
}

export function tacAwdRow(over = {}) {
  return {
    rowIndex: 8,
    sku: 'TEST-1',
    b2b: false,
    critical: false,
    rate: 10,
    lifecycle: 'Stable',
    tacAvailableUnits: 1000,
    availableCases: 50,
    wrDoi: 100,
    awdQty: 600,
    awdInbound14: 0,
    awdDoi: 60,
    caseQty: 20,
    minUnits: 0,
    fbaDoi: 60,
    ...over,
  };
}

export function tacFbaRow(over = {}) {
  return {
    rowIndex: 8,
    sku: 'TEST-1',
    b2b: false,
    critical: false,
    rate: 10,
    lifecycle: 'Stable',
    tacAvailableUnits: 1000,
    availableCases: 50,
    tacDoi: 100,
    amzFulfillable: 300,
    amzReserved: 0,
    amzInbound: 0,
    amzTotal: 300,
    amzDoi: 30,
    caseQty: 20,
    minUnits: 0,
    awdAvailableUnits: 0,
    ...over,
  };
}
