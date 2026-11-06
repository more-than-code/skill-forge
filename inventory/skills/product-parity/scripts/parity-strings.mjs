// String tables for the i18n checks (B, C and locale coverage).
//
// WHY A PARSER, NOT A LINE REGEX
// ------------------------------
// The first version matched `key: 'value',` one line at a time and COUNTED everything else
// as "not single-line, excluded". Formatters wrap long values onto the next line, so the
// exclusion landed on exactly the longest strings — and a count printed as a note reads as
// green. Observed on one project (2026-11-06): 60 source entries sat outside the drift check,
// 8 of them among the 70 keys that were silently falling back to English.
//
// So: read object and map literals properly — keys on one line and values on the next,
// single, double and triple quotes, `+` and adjacent-literal concatenation — and report
// every value that is still not a plain string by KEY, so the gate can fail on it rather
// than describe it.
//
// Formats:
//   ts-object / js-object  the first `{ … }` object literal in the file (a flat table)
//   json / arb             a flat JSON object; `@`-prefixed keys are metadata and dropped
//   dart-map               a locale → table map literal, found by its variable name
//                          (default `_localizedValues`): the map a Flutter app actually reads
import { readFileSync } from 'node:fs';

export function readTable(file, format) {
  const src = readFileSync(file, 'utf8');
  if (format === 'json' || format === 'arb') return { values: dropMeta(JSON.parse(src)), unparsed: [] };
  if (format === 'ts-object' || format === 'js-object') {
    const start = src.indexOf('{');
    if (start < 0) throw new Error(`${file}: no object literal found`);
    const { value } = new Reader(src, start).object();
    return flatten(value);
  }
  throw new Error(`unknown string-table format "${format}" for ${file}`);
}

// Returns { locales: { <locale>: { values, unparsed } } }.
export function readLocaleMap(file, variable = '_localizedValues') {
  const src = readFileSync(file, 'utf8');
  const at = src.search(new RegExp(`\\b${variable}\\s*=`));
  if (at < 0) throw new Error(`${file}: no "${variable} =" map literal found`);
  const { value } = new Reader(src, src.indexOf('=', at) + 1).value();
  if (!isObject(value)) throw new Error(`${file}: "${variable}" is not a map literal`);
  const locales = {};
  for (const [locale, table] of Object.entries(value.entries)) {
    if (isObject(table)) locales[locale] = flatten(table);
  }
  return { locales };
}

const dropMeta = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('@')));
const isObject = (v) => v && typeof v === 'object' && v.kind === 'object';

function flatten(obj) {
  const values = {};
  const unparsed = [];
  for (const [k, v] of Object.entries(obj.entries)) {
    if (k.startsWith('@')) continue;
    if (typeof v === 'string') values[k] = v;
    else unparsed.push(k);
  }
  return { values, unparsed };
}

// A small reader for the literal subset string tables use. Anything it does not understand
// (a call, an identifier, a template with interpolation) becomes UNPARSED for that key — it
// never guesses, and it never silently drops the key.
const UNPARSED = Symbol('unparsed');

class Reader {
  constructor(src, i) {
    this.s = src;
    this.i = i;
  }

  ws() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (this.s.startsWith('//', this.i)) this.i = this.lineEnd();
      else if (this.s.startsWith('/*', this.i)) this.i = this.s.indexOf('*/', this.i + 2) + 2;
      else return;
    }
  }

  lineEnd() {
    const n = this.s.indexOf('\n', this.i);
    return n < 0 ? this.s.length : n;
  }

  value() {
    this.ws();
    // Dart type arguments before a literal: `<String, String>{`.
    if (this.s[this.i] === '<') this.skipBalanced('<', '>');
    this.ws();
    if (this.s[this.i] === '{') return this.object();
    if (this.atString()) return { value: this.concatenation() };
    this.skipExpression();
    return { value: UNPARSED };
  }

  object() {
    this.i++; // {
    const entries = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return { value: { kind: 'object', entries } };
      }
      if (this.s[this.i] === ',') {
        this.i++;
        continue;
      }
      if (this.s.startsWith('...', this.i)) {
        this.skipExpression(); // a spread: its keys are not knowable here
        continue;
      }
      const key = this.key();
      this.ws();
      if (this.s[this.i] !== ':') throw new Error(`expected ":" after key "${key}" at offset ${this.i}`);
      this.i++;
      const { value } = this.value();
      entries[key] = value;
    }
  }

  key() {
    if (this.atString()) {
      const k = this.string();
      return k === UNPARSED ? `<interpolated key at ${this.i}>` : k;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new Error(`unexpected "${this.s[this.i]}" at offset ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }

  atString() {
    const c = this.s[this.i];
    return c === "'" || c === '"' || c === '`' || ((c === 'r' || c === 'R') && /['"]/.test(this.s[this.i + 1]));
  }

  // 'a' + 'b' (JS, Dart) and 'a' 'b' (Dart adjacent literals) both concatenate.
  concatenation() {
    let out = this.string();
    for (;;) {
      const save = this.i;
      this.ws();
      if (this.s[this.i] === '+') {
        this.i++;
        this.ws();
      }
      if (!this.atString()) {
        this.i = save;
        break;
      }
      const next = this.string();
      out = out === UNPARSED || next === UNPARSED ? UNPARSED : out + next;
    }
    this.ws();
    // Anything else in the expression (a method call, a ternary) makes it not a plain string.
    if (this.s[this.i] !== ',' && this.s[this.i] !== '}') {
      this.skipExpression();
      return UNPARSED;
    }
    return out;
  }

  string() {
    let raw = false;
    if (this.s[this.i] === 'r' || this.s[this.i] === 'R') {
      raw = true;
      this.i++;
    }
    const q = this.s[this.i];
    const triple = q !== '`' && this.s.startsWith(q.repeat(3), this.i);
    const close = triple ? q.repeat(3) : q;
    this.i += close.length;
    let out = '';
    let interpolated = false;
    while (!this.s.startsWith(close, this.i)) {
      if (this.i >= this.s.length) throw new Error('unterminated string literal');
      const c = this.s[this.i];
      if (c === '\\' && !raw) {
        out += unescape(this.s, this.i + 1);
        this.i += escapeLength(this.s, this.i + 1) + 1;
        continue;
      }
      if (q === '`' && this.s.startsWith('${', this.i)) interpolated = true;
      out += c;
      this.i++;
    }
    this.i += close.length;
    return interpolated ? UNPARSED : out;
  }

  skipBalanced(open, closeCh) {
    let depth = 0;
    do {
      if (this.s[this.i] === open) depth++;
      else if (this.s[this.i] === closeCh) depth--;
      this.i++;
    } while (depth > 0 && this.i < this.s.length);
  }

  // Skip to the `,` or `}` that ends this entry, stepping over nested brackets and strings.
  skipExpression() {
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (depth === 0 && (c === ',' || c === '}')) return;
      if (this.atString()) {
        this.string();
        continue;
      }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      this.i++;
    }
  }
}

const SIMPLE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

function unescape(s, i) {
  const c = s[i];
  if (c in SIMPLE) return SIMPLE[c];
  if (c === 'u') {
    if (s[i + 1] === '{') return String.fromCodePoint(parseInt(s.slice(i + 2, s.indexOf('}', i)), 16));
    return String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
  }
  if (c === 'x') return String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
  return c; // \' \" \\ \$ \`
}

function escapeLength(s, i) {
  const c = s[i];
  if (c === 'u') return s[i + 1] === '{' ? s.indexOf('}', i) - i + 1 : 5;
  if (c === 'x') return 3;
  return 1;
}
