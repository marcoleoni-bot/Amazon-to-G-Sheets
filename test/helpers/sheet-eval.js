/**
 * A small Google Sheets formula evaluator, for testing the formulas the
 * planner writes.
 *
 * The planner now holds two implementations of the same rules: the modules in
 * Rules_*.gs, and the formulas Formulas.gs writes into the lanes. Two
 * implementations drift. The only defence that actually works is to run both
 * over the same inputs and require the same answer, which is what this exists
 * for — it parses and evaluates the exact formula strings that get written to
 * the sheet, against a grid built from the same fixtures the rule tests use.
 *
 * It covers the subset the planner emits and nothing more: IF/AND/OR/NOT, N,
 * MAX/MIN/FLOOR/ROUNDUP/SUM, the IS* predicates, IFERROR, MATCH, VLOOKUP,
 * UPPER/LOWER/TRIM, arithmetic, comparison and `&`. Anything else throws
 * rather than guessing, so a formula using something untested fails here
 * instead of in production.
 */

/** A sheet error, propagated the way Sheets propagates one. */
export class SheetError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}

const NA = () => new SheetError('#N/A');
const isErr = (v) => v instanceof SheetError;

// ------------------------------------------------------------------ tokenizer

const TOKENS = [
  ['sheet', /^'((?:[^']|'')*)'!/],
  ['string', /^"((?:[^"]|"")*)"/],
  ['number', /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/],
  ['colrange', /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![A-Za-z0-9_])/],
  ['cellrange', /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})(?:\$?(\d+))?(?![A-Za-z0-9_])/],
  ['cell', /^\$?([A-Z]{1,3})\$?(\d+)(?![A-Za-z0-9_])/],
  ['ident', /^[A-Za-z_][A-Za-z0-9_]*/],
  ['op', /^(<=|>=|<>|[-+*/&=<>(),])/],
];

function tokenize(src) {
  let s = src;
  const out = [];
  while (s.length) {
    if (/^\s/.test(s)) { s = s.replace(/^\s+/, ''); continue; }
    let hit = null;
    for (const [kind, re] of TOKENS) {
      const m = re.exec(s);
      if (!m) continue;
      hit = { kind, m };
      s = s.slice(m[0].length);
      break;
    }
    if (!hit) throw new Error(`cannot tokenize at: ${s.slice(0, 40)}`);
    out.push(hit);
  }
  return out;
}

// --------------------------------------------------------------------- parser

/**
 * Precedence, loosest first: comparison, concat, additive, multiplicative,
 * unary minus, primary. Sheets' own order.
 */
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek() && peek().kind === 'op' && peek().m[0] === v;
  const eat = (v) => {
    if (!isOp(v)) throw new Error(`expected ${v}, saw ${peek() ? peek().m[0] : 'end'}`);
    i++;
  };

  function comparison() {
    let left = concat();
    while (peek() && peek().kind === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().m[0])) {
      const op = tokens[i++].m[0];
      left = { t: 'bin', op, left, right: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) { i++; left = { t: 'bin', op: '&', left, right: additive() }; }
    return left;
  }
  function additive() {
    let left = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].m[0];
      left = { t: 'bin', op, left, right: multiplicative() };
    }
    return left;
  }
  function multiplicative() {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++].m[0];
      left = { t: 'bin', op, left, right: unary() };
    }
    return left;
  }
  function unary() {
    if (isOp('-')) { i++; return { t: 'neg', arg: unary() }; }
    if (isOp('+')) { i++; return unary(); }
    return primary();
  }
  function primary() {
    const tok = peek();
    if (!tok) throw new Error('unexpected end of formula');

    if (tok.kind === 'op' && tok.m[0] === '(') {
      i++;
      const inner = comparison();
      eat(')');
      return inner;
    }
    if (tok.kind === 'number') { i++; return { t: 'num', v: Number(tok.m[0]) }; }
    if (tok.kind === 'string') { i++; return { t: 'str', v: tok.m[1].replace(/""/g, '"') }; }

    if (tok.kind === 'sheet') {
      i++;
      const sheet = tok.m[1].replace(/''/g, "'");
      const ref = primary();
      if (!['cell', 'colrange', 'cellrange'].includes(ref.t)) {
        throw new Error(`'${sheet}'! must be followed by a reference`);
      }
      return { ...ref, sheet };
    }
    if (tok.kind === 'cell') { i++; return { t: 'cell', col: tok.m[1], row: Number(tok.m[2]) }; }
    if (tok.kind === 'colrange') {
      i++;
      return { t: 'colrange', from: tok.m[1], to: tok.m[2] };
    }
    if (tok.kind === 'cellrange') {
      i++;
      return { t: 'cellrange', from: tok.m[1], fromRow: Number(tok.m[2]),
        to: tok.m[3], toRow: tok.m[4] ? Number(tok.m[4]) : null };
    }
    if (tok.kind === 'ident') {
      const upper = tok.m[0].toUpperCase();
      if ((upper === 'TRUE' || upper === 'FALSE') && !(tokens[i + 1]
        && tokens[i + 1].kind === 'op' && tokens[i + 1].m[0] === '(')) {
        i++;
        return { t: 'bool', v: upper === 'TRUE' };
      }
      i++;
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) {
          args.push(comparison());
          while (isOp(',')) { i++; args.push(comparison()); }
        }
        eat(')');
        return { t: 'call', name: tok.m[0].toUpperCase(), args };
      }
      return { t: 'name', name: tok.m[0] };
    }
    throw new Error(`unexpected token ${tok.m[0]}`);
  }

  const ast = comparison();
  if (i !== tokens.length) throw new Error(`trailing input at ${tokens[i].m[0]}`);
  return ast;
}

export function parseFormula(src) {
  return parse(tokenize(String(src).replace(/^=/, '')));
}

// ------------------------------------------------------------------- workbook

const colToIndex = (letters) => letters.split('').reduce(
  (n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/**
 * A workbook of lazily-evaluated grids.
 *
 *   sheets  { tabName: [[cell, ...], ...] } — row 0 is sheet row 1. A cell is
 *           a literal, or a string starting with '=' which is evaluated on
 *           demand and memoised.
 *   names   { NamedRange: value | 2D array }
 */
export class Workbook {
  constructor(sheets, names) {
    this.sheets = sheets;
    this.names = names || {};
    this.cache = new Map();
    this.stack = new Set();
  }

  grid(name) {
    const g = this.sheets[name];
    if (!g) throw new Error(`no such sheet: "${name}"`);
    return g;
  }

  raw(sheet, row, col) {
    const g = this.grid(sheet);
    const r = g[row - 1];
    if (!r) return '';
    const v = r[col];
    return v === undefined || v === null ? '' : v;
  }

  value(sheet, row, col) {
    const key = `${sheet}!${row}:${col}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const raw = this.raw(sheet, row, col);
    if (typeof raw !== 'string' || raw[0] !== '=') return raw;

    if (this.stack.has(key)) throw new Error(`circular reference at ${key}`);
    this.stack.add(key);
    let out;
    try {
      out = evaluate(parseFormula(raw), this, sheet, row);
    } finally {
      this.stack.delete(key);
    }
    this.cache.set(key, out);
    return out;
  }

  /** The last row of a sheet that has anything in it. */
  lastRow(sheet) {
    const g = this.grid(sheet);
    for (let r = g.length; r > 0; r--) {
      const row = g[r - 1] || [];
      if (row.some((c) => c !== '' && c !== null && c !== undefined)) return r;
    }
    return 0;
  }
}

// ------------------------------------------------------------------ evaluator

function toNumber(v) {
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : new SheetError('#VALUE!');
}

/** N(): text becomes 0 rather than an error; errors still propagate. */
function coerceN(v) {
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).trim());
  return v !== '' && Number.isFinite(n) ? n : 0;
}

function toBool(v) {
  if (isErr(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE' || s === '') return false;
  return new SheetError('#VALUE!');
}

function compare(op, a, b) {
  // Sheets sorts every number before every string.
  const rank = (v) => (typeof v === 'number' ? 0 : (typeof v === 'boolean' ? 2 : 1));
  let x = a === '' ? (typeof b === 'number' ? 0 : '') : a;
  let y = b === '' ? (typeof a === 'number' ? 0 : '') : b;
  if (typeof x === 'string' && typeof y === 'string') {
    x = x.toUpperCase(); y = y.toUpperCase();
  }
  let cmp;
  if (rank(x) !== rank(y)) cmp = rank(x) - rank(y);
  else if (typeof x === 'number') cmp = x - y;
  else cmp = x < y ? -1 : (x > y ? 1 : 0);

  switch (op) {
    case '=': return cmp === 0;
    case '<>': return cmp !== 0;
    case '<': return cmp < 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '>=': return cmp >= 0;
    default: throw new Error(`unknown comparison ${op}`);
  }
}

/** Every cell a range covers, as a flat list of resolved values. */
function rangeValues(node, wb, sheet) {
  const tab = node.sheet || sheet;
  const first = colToIndex(node.from);
  const last = colToIndex(node.to);
  const fromRow = node.t === 'cellrange' ? node.fromRow : 1;
  const toRow = node.t === 'cellrange'
    ? (node.toRow || wb.lastRow(tab))
    : wb.lastRow(tab);

  const rows = [];
  for (let r = fromRow; r <= toRow; r++) {
    const row = [];
    for (let c = first; c <= last; c++) row.push(wb.value(tab, r, c));
    rows.push(row);
  }
  return rows;
}

const FUNCTIONS = {
  IF: (args, ev) => {
    const c = toBool(ev(args[0]));
    if (isErr(c)) return c;
    return c ? ev(args[1]) : (args.length > 2 ? ev(args[2]) : false);
  },
  IFERROR: (args, ev) => {
    const v = ev(args[0]);
    return isErr(v) ? (args.length > 1 ? ev(args[1]) : '') : v;
  },
  AND: (args, ev) => {
    for (const a of args) {
      const v = toBool(ev(a));
      if (isErr(v)) return v;
      if (!v) return false;
    }
    return true;
  },
  OR: (args, ev) => {
    for (const a of args) {
      const v = toBool(ev(a));
      if (isErr(v)) return v;
      if (v) return true;
    }
    return false;
  },
  NOT: (args, ev) => {
    const v = toBool(ev(args[0]));
    return isErr(v) ? v : !v;
  },
  N: (args, ev) => coerceN(ev(args[0])),
  ISNUMBER: (args, ev) => typeof ev(args[0]) === 'number',
  ISERROR: (args, ev) => isErr(ev(args[0])),
  ISNA: (args, ev) => { const v = ev(args[0]); return isErr(v) && v.code === '#N/A'; },
  ISBLANK: (args, ev) => ev(args[0]) === '',
  UPPER: (args, ev) => String(ev(args[0]) ?? '').toUpperCase(),
  LOWER: (args, ev) => String(ev(args[0]) ?? '').toLowerCase(),
  TRIM: (args, ev) => String(ev(args[0]) ?? '').replace(/\s+/g, ' ').trim(),
  ROUNDUP: (args, ev) => {
    const x = toNumber(ev(args[0]));
    if (isErr(x)) return x;
    const places = args.length > 1 ? toNumber(ev(args[1])) : 0;
    const f = 10 ** places;
    return x < 0 ? -Math.ceil(-x * f) / f : Math.ceil(x * f) / f;
  },
  FLOOR: (args, ev) => {
    const x = toNumber(ev(args[0]));
    if (isErr(x)) return x;
    const step = args.length > 1 ? toNumber(ev(args[1])) : 1;
    if (isErr(step)) return step;
    return step === 0 ? 0 : Math.floor(x / step) * step;
  },
  MAX: (args, ev) => reduceNumeric(args, ev, Math.max, -Infinity),
  MIN: (args, ev) => reduceNumeric(args, ev, Math.min, Infinity),
  SUM: (args, ev) => reduceNumeric(args, ev, (a, b) => a + b, 0),
  INDEX: (args, ev, wb, sheet) => {
    const grid = args[0].t === 'name'
      ? (wb.names[args[0].name] || [])
      : rangeValues(args[0], wb, sheet);
    const r = toNumber(ev(args[1]));
    if (isErr(r)) return r;
    const c = args.length > 2 ? toNumber(ev(args[2])) : 1;
    if (isErr(c)) return c;
    const row = grid[r - 1];
    if (!row) return new SheetError('#REF!');
    const v = row[c - 1];
    return v === undefined ? new SheetError('#REF!') : v;
  },
  MATCH: (args, ev, wb, sheet) => {
    const key = ev(args[0]);
    if (isErr(key)) return key;
    const grid = rangeValues(args[1], wb, sheet);
    for (let r = 0; r < grid.length; r++) {
      const cell = grid[r][0];
      if (!isErr(cell) && compare('=', cell, key)) return r + 1;
    }
    return NA();
  },
  VLOOKUP: (args, ev, wb, sheet) => {
    const key = ev(args[0]);
    if (isErr(key)) return key;
    const grid = args[1].t === 'name'
      ? (wb.names[args[1].name] || [])
      : rangeValues(args[1], wb, sheet);
    const idx = toNumber(ev(args[2]));
    if (isErr(idx)) return idx;
    for (const row of grid) {
      if (!isErr(row[0]) && compare('=', row[0], key)) {
        const v = row[idx - 1];
        return v === undefined ? NA() : v;
      }
    }
    return NA();
  },
};

function reduceNumeric(args, ev, fn, seed) {
  let acc = seed;
  let saw = false;
  for (const a of args) {
    const v = ev(a);
    if (isErr(v)) return v;
    const list = Array.isArray(v) ? v.flat() : [v];
    for (const item of list) {
      if (item === '' || typeof item === 'string') continue;
      const n = toNumber(item);
      if (isErr(n)) return n;
      acc = fn(acc, n);
      saw = true;
    }
  }
  return saw ? acc : 0;
}

export function evaluate(node, wb, sheet, row) {
  const ev = (n) => evaluate(n, wb, sheet, row);

  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'cell': return wb.value(node.sheet || sheet, node.row, colToIndex(node.col));
    case 'colrange':
    case 'cellrange': return rangeValues(node, wb, sheet);
    case 'name': {
      if (!(node.name in wb.names)) return new SheetError('#NAME?');
      return wb.names[node.name];
    }
    case 'neg': {
      const v = toNumber(ev(node.arg));
      return isErr(v) ? v : -v;
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`unsupported function ${node.name}()`);
      return fn(node.args, ev, wb, sheet);
    }
    case 'bin': {
      const a = ev(node.left);
      if (isErr(a)) return a;
      const b = ev(node.right);
      if (isErr(b)) return b;
      if (node.op === '&') {
        return `${a === '' ? '' : a}${b === '' ? '' : b}`;
      }
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
        return compare(node.op, a, b);
      }
      const x = toNumber(a);
      if (isErr(x)) return x;
      const y = toNumber(b);
      if (isErr(y)) return y;
      switch (node.op) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return y === 0 ? new SheetError('#DIV/0!') : x / y;
        default: throw new Error(`unknown operator ${node.op}`);
      }
    }
    default: throw new Error(`unknown node ${node.t}`);
  }
}
