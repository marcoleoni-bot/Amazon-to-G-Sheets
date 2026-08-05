import { google } from 'googleapis';
import { SPREADSHEET_ID } from './config.js';
import { log } from './log.js';

/**
 * Row 1 of every tab holds headers that Calc_Data and a dozen human-written
 * formulas point at. Nothing here ever writes to row 1: we clear A2:AZ and
 * write from A2.
 *
 * valueInputOption is RAW throughout. With USER_ENTERED, Sheets reinterprets
 * values on the way in — SKUs like "10-24" become dates, leading zeros vanish,
 * and the damage is silent.
 */

const RANGE_FROM_ROW_2 = 'A2:AZ';
const WRITE_ANCHOR = 'A2';

export async function connect() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const email = client.email || (await auth.getCredentials().catch(() => ({}))).client_email;
  return { api: google.sheets({ version: 'v4', auth }), serviceAccountEmail: email };
}

export async function listTabs(api) {
  try {
    const res = await api.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties.title',
    });
    return res.data.sheets.map((s) => s.properties.title);
  } catch (err) {
    if (err.code === 403 || err.code === 404) {
      throw new Error(
        `Cannot open spreadsheet ${SPREADSHEET_ID} (${err.code}). Share it with the `
        + 'service account\'s email address, with Editor access, and make sure the '
        + 'Sheets API is enabled on that project.');
    }
    throw err;
  }
}

/** Tab names are quoted because they all contain spaces. */
const range = (tab, suffix) => `'${tab.replace(/'/g, "''")}'!${suffix}`;

export async function clearAndWrite(api, tab, values) {
  await api.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: range(tab, RANGE_FROM_ROW_2),
  });

  if (!values.length) {
    log.warn(`${tab}: cleared, but there were no rows to write`);
    return { tab, rows: 0 };
  }

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: range(tab, WRITE_ANCHOR),
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  return { tab, rows: values.length, columns: values[0].length };
}

/**
 * Confirm every tab we intend to write exists before writing any of them —
 * a typo'd tab name should stop the run, not create a tab or half-write.
 */
export function assertTabsExist(existing, wanted) {
  const have = new Set(existing);
  const missing = wanted.filter((t) => !have.has(t));
  if (missing.length) {
    throw new Error(
      `These tabs do not exist in the spreadsheet: ${missing.join(', ')}.\n`
      + `  Tabs found: ${existing.join(', ')}`);
  }
}
