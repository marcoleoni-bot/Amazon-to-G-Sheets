import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Overridable so the test suite can work in a temp dir instead of schemas/. */
export const SCHEMA_DIR = process.env.SCHEMA_DIR || join(HERE, '..', 'schemas');

/**
 * Baselines are stored per *schema group*, not per marketplace: US and CA share
 * the NA inventory layout, UK and DE share the EU one. That is deliberate —
 * if Amazon rolls a column change out to Canada first, the NA baseline catches
 * it on the CA pull instead of quietly accepting two different NA layouts.
 */
export function schemaKey(kind, mp) {
  return kind === 'inventory' ? `inventory.${mp.region}` : 'sales';
}

const pathFor = (key) => join(SCHEMA_DIR, `${key}.json`);

export function loadSchema(key) {
  const file = pathFor(key);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveSchema(key, columns, { provisional = false, note = '' } = {}) {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const body = {
    key,
    provisional,
    note,
    recordedAt: new Date().toISOString(),
    columnCount: columns.length,
    columns,
  };
  writeFileSync(pathFor(key), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

export function listSchemas() {
  if (!existsSync(SCHEMA_DIR)) return [];
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')));
}
