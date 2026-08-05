import { parse } from 'csv-parse/sync';

/**
 * The same report arrives as tab-separated one day and quoted CSV the next,
 * with no pattern anyone has found. So: sniff the header line, and parse
 * permissively enough that a stray quote inside a product title doesn't take
 * down the run.
 */

/** Strip the UTF-8 BOM. Left in place it becomes part of the first header name. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decide the delimiter from the header line by counting candidates.
 * Counting on the header rather than the whole file matters: product names are
 * full of commas, so a tab-separated file can easily contain more commas than
 * tabs overall while its header contains none.
 */
export function detectDelimiter(text) {
  const header = stripBom(text).split(/\r?\n/, 1)[0] || '';
  const tabs = (header.match(/\t/g) || []).length;
  const commas = (header.match(/,/g) || []).length;
  const semis = (header.match(/;/g) || []).length;

  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas && semis > 0) return ';';
  if (commas > 0) return ',';
  // Single-column file, or a header we don't understand. Tab is the safer
  // default here — a comma would split product names that a tab would not.
  return '\t';
}

/**
 * Parse a Seller Central report into { header, rows, delimiter }.
 * `rows` are arrays, not objects: the sheet is written positionally and any
 * conversion to objects would invite someone to "helpfully" reorder them.
 */
export function parseReport(buffer) {
  const text = stripBom(buffer.toString('utf8'));
  if (!text.trim()) {
    throw new Error('Report file is empty.');
  }

  const delimiter = detectDelimiter(text);
  const records = parse(text, {
    delimiter,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
    trim: false,
  });

  if (!records.length) {
    throw new Error('Report file parsed to zero rows.');
  }

  const [header, ...rows] = records;
  return {
    header: header.map((h) => h.trim()),
    rows,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
  };
}

/** Index of a column by exact header name; -1 if absent. */
export function columnIndex(header, name) {
  return header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}
