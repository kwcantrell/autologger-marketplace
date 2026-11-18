// A small, dependency-free reader for the block-style YAML that autologger's scripts/lifecycle.yaml
// is written in. It aims to give the same values as PyYAML's safe_load (which autologger's own
// gates use) for what it accepts, and to refuse everything else with a line number instead of
// guessing.
//
// Supported: comments; block mappings and block sequences (including a sequence at the same indent
// as its parent key, and `- key: value` items); plain scalars, also continued over several lines;
// single- and double-quoted scalars, also over several lines; literal `|` and folded `>` block
// scalars with chomping and indentation indicators; one-line flow collections (`[a, b]`, `{a: b}`);
// a leading `---`. Plain scalars resolve like PyYAML (YAML 1.1): null, booleans (yes/no/on/off too),
// ints (incl. 0x, 0b, old-style octal, base 60), floats, timestamps.
//
// Refused with a YamlError: anchors, aliases, tags, `?` complex keys, merge keys (`<<`), directives,
// multiple documents, tabs in indentation, multi-line flow collections, and anything malformed.

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

/** A YAML timestamp (`2001-12-14`): not a string, so a glob list drops it like PyYAML's date. */
export class YamlTimestamp {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toJSON(): string {
    return this.text;
  }
}

export type YamlMap = { [key: string]: unknown };

export function isYamlMap(value: unknown): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof YamlTimestamp);
}

/** Python's str() of a scalar key, which is how autologger reads spec names (`str(k)`). */
export function pyStr(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return String(value);
  }
  if (value instanceof YamlTimestamp) return value.text;
  return String(value);
}

export function parseYaml(text: string): unknown {
  return new Parser(text).document();
}

interface Pos {
  line: number; // index into lines
  col: number; // column where the content starts
}

const UNSUPPORTED_START: Record<string, string> = {
  '&': 'anchors (&) are not supported',
  '*': 'aliases (*) are not supported',
  '!': 'tags (!) are not supported',
  '%': 'a plain value cannot start with %',
  '@': 'a plain value cannot start with @ (reserved)',
  '`': 'a plain value cannot start with ` (reserved)',
  ',': 'a plain value cannot start with ,',
  ']': 'a plain value cannot start with ]',
  '}': 'a plain value cannot start with }',
};

class Parser {
  private readonly lines: string[];
  private next = 0; // first line not yet consumed
  private virtual: Pos | null = null; // content after `- ` on a line already partly consumed

  constructor(text: string) {
    if (text.startsWith('﻿')) text = text.slice(1);
    this.lines = text.replace(/\r\n?/g, '\n').split('\n');
  }

  document(): unknown {
    let pos = this.peek();
    if (pos && /^%/.test(this.text(pos))) this.fail(pos, 'directives (%) are not supported');
    if (pos && isMarker(this.text(pos), '---')) {
      const rest = this.text(pos).slice(3).trim();
      if (rest !== '' && !rest.startsWith('#')) this.fail(pos, 'content after `---` is not supported');
      this.next = pos.line + 1;
      pos = this.peek();
    }
    if (!pos || isMarker(this.text(pos), '...')) {
      this.end(pos);
      return null;
    }
    const value = this.node(pos, -1);
    this.end(this.peek());
    return value;
  }

  private end(pos: Pos | null): void {
    if (!pos) return;
    if (isMarker(this.text(pos), '...')) {
      this.next = pos.line + 1;
      const after = this.peek();
      if (after) this.fail(after, 'multiple YAML documents are not supported');
      return;
    }
    if (isMarker(this.text(pos), '---')) this.fail(pos, 'multiple YAML documents are not supported');
    this.fail(pos, 'unexpected content (bad indentation?)');
  }

  // ---------------------------------------------------------------- positions

  private fail(pos: Pos | number, message: string): never {
    throw new YamlError(message, (typeof pos === 'number' ? pos : pos.line) + 1);
  }

  private text(pos: Pos): string {
    return (this.lines[pos.line] ?? '').slice(pos.col);
  }

  /** The next content position: the rest of a `- ` line, or the next line that is not blank or a comment. */
  private peek(): Pos | null {
    if (this.virtual) return this.virtual;
    for (let i = this.next; i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      const rest = line.slice(indent.length);
      if (rest === '' || rest.startsWith('#')) continue;
      if (indent.includes('\t')) this.fail(i, 'tabs are not allowed in indentation');
      this.next = i;
      return { line: i, col: indent.length };
    }
    this.next = this.lines.length;
    return null;
  }

  /** Marks everything up to the end of pos.line as consumed. */
  private consumeLine(pos: Pos): void {
    this.virtual = null;
    this.next = pos.line + 1;
  }

  // ---------------------------------------------------------------- block structure

  /** A node whose first content is at pos; parentCol is the indentation of its parent. */
  private node(pos: Pos, parentCol: number): unknown {
    const text = this.text(pos);
    if (isDash(text)) return this.sequence(pos.col);
    if (text.startsWith('? ') || text === '?') this.fail(pos, 'complex keys (?) are not supported');
    if (splitKey(text, pos, this) !== null) return this.mapping(pos.col);
    return this.scalarAt(pos, parentCol);
  }

  private sequence(col: number): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      const pos = this.peek();
      if (!pos || pos.col < col) break;
      if (pos.col > col) this.fail(pos, 'bad indentation in a sequence');
      const text = this.text(pos);
      if (atMarker(pos, text)) break;
      if (!isDash(text)) break;
      const after = text.slice(1);
      const gap = /^[ \t]*/.exec(after)?.[0].length ?? 0;
      const rest = after.slice(gap);
      if (rest === '' || rest.startsWith('#')) {
        this.consumeLine(pos);
        items.push(this.blockBelow(col, false));
      } else {
        if (after.slice(0, gap).includes('\t')) this.fail(pos, 'tabs are not allowed in indentation');
        this.virtual = { line: pos.line, col: pos.col + 1 + gap };
        items.push(this.node(this.virtual, col));
      }
    }
    return items;
  }

  private mapping(col: number): YamlMap {
    const map: YamlMap = Object.create(null) as YamlMap;
    for (;;) {
      const pos = this.peek();
      if (!pos || pos.col < col) break;
      if (pos.col > col) this.fail(pos, 'bad indentation in a mapping');
      const text = this.text(pos);
      if (atMarker(pos, text)) break;
      if (isDash(text)) break; // an indentless sequence ended; the caller decides
      if (text.startsWith('? ') || text === '?') this.fail(pos, 'complex keys (?) are not supported');
      const split = splitKey(text, pos, this);
      if (split === null) this.fail(pos, 'expected `key: value` in a mapping');
      if (split.key === '<<' && !split.quoted) this.fail(pos, 'merge keys (<<) are not supported');
      const key = split.quoted ? split.key : resolvePlain(split.key);
      const valueCol = pos.col + split.valueOffset;
      const rest = (this.lines[pos.line] ?? '').slice(valueCol);
      let value: unknown;
      if (rest === '' || /^#/.test(rest)) {
        this.consumeLine(pos);
        value = this.blockBelow(col, true);
      } else {
        const valuePos = { line: pos.line, col: valueCol };
        if (isDash(rest)) this.fail(valuePos, 'a block sequence cannot start on the line of its key');
        if (splitKey(rest, valuePos, this) !== null) this.fail(valuePos, 'a mapping value cannot be a mapping on the same line');
        this.virtual = null;
        value = this.scalarAt(valuePos, col);
      }
      setKey(map, key, value);
    }
    return map;
  }

  /** The value on the lines after a `key:` or `-` that had nothing after it. */
  private blockBelow(col: number, allowIndentlessSequence: boolean): unknown {
    const pos = this.peek();
    if (!pos) return null;
    if (pos.col > col) return this.node(pos, col);
    if (pos.col === col && allowIndentlessSequence && isDash(this.text(pos))) return this.sequence(col);
    return null;
  }

  // ---------------------------------------------------------------- scalars

  private scalarAt(pos: Pos, parentCol: number): unknown {
    const text = this.text(pos);
    const first = text[0] ?? '';
    if (first === "'" || first === '"') return this.quoted(pos);
    if (first === '|' || first === '>') return this.blockScalar(pos, parentCol);
    if (first === '[' || first === '{') return this.flow(pos);
    if (first === '#') this.fail(pos, 'expected a value');
    const why = UNSUPPORTED_START[first];
    if (why) this.fail(pos, why);
    return this.plain(pos, parentCol);
  }

  private plain(pos: Pos, parentCol: number): unknown {
    const parts: string[] = [];
    let { text: firstText, ended } = cutComment(this.text(pos));
    checkPlainLine(firstText, pos, this);
    parts.push(firstText.trim());
    this.consumeLine(pos);
    let multiline = false;
    let blanks = 0;
    let i = this.next;
    while (!ended && i < this.lines.length) {
      const line = this.lines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed === '') {
        blanks++;
        i++;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= parentCol || trimmed.startsWith('#')) break;
      if (isMarker(trimmed, '---') || isMarker(trimmed, '...')) break;
      const cut = cutComment(trimmed);
      checkPlainLine(cut.text, { line: i, col: indent }, this);
      parts.push('\n'.repeat(blanks) || ' ', cut.text.trim());
      blanks = 0;
      multiline = true;
      ended = cut.ended;
      i++;
      this.next = i;
    }
    const value = parts.join('');
    return multiline ? value : resolvePlain(value);
  }

  private quoted(pos: Pos): string {
    const quote = this.text(pos)[0] as "'" | '"';
    const pieces: string[] = []; // one per source line
    let line = pos.line;
    let start = pos.col + 1;
    let escapedBreaks = new Set<number>(); // piece indexes ending in `\` (double quotes)
    for (;;) {
      const raw = this.lines[line];
      if (raw === undefined) this.fail(pos, `unterminated ${quote === "'" ? 'single' : 'double'}-quoted value`);
      const close = findClose(raw, start, quote);
      if (close >= 0) {
        pieces.push(raw.slice(start, close));
        const after = raw.slice(close + 1).trim();
        if (after !== '' && !after.startsWith('#')) this.fail(line, 'unexpected text after a quoted value');
        this.consumeLine({ line, col: 0 });
        break;
      }
      let piece = raw.slice(start);
      if (quote === '"' && /(^|[^\\])(\\\\)*\\$/.test(piece)) {
        piece = piece.slice(0, -1);
        escapedBreaks.add(pieces.length);
      }
      pieces.push(piece);
      line++;
      start = 0;
    }
    const unescape = quote === "'" ? (s: string) => s.replaceAll("''", "'") : (s: string) => unescapeDouble(s, line, this);
    if (pieces.length === 1) return unescape(pieces[0] ?? '');
    // Fold line breaks: one break becomes a space, each blank line a newline.
    let out = unescape((pieces[0] ?? '').replace(/[ \t]+$/, ''));
    let blanks = 0;
    let joinBare = escapedBreaks.has(0);
    for (let k = 1; k < pieces.length; k++) {
      const last = k === pieces.length - 1;
      let piece = (pieces[k] ?? '').replace(/^[ \t]+/, '');
      if (!last) piece = piece.replace(/[ \t]+$/, '');
      if (piece === '' && !last) {
        blanks++;
        continue;
      }
      out += joinBare ? '' : blanks > 0 ? '\n'.repeat(blanks) : ' ';
      out += unescape(piece);
      blanks = 0;
      joinBare = escapedBreaks.has(k);
    }
    escapedBreaks = new Set();
    return out;
  }

  private blockScalar(pos: Pos, parentCol: number): string {
    const header = cutComment(this.text(pos)).text.trim();
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header);
    if (!m || (m[2] && m[4])) this.fail(pos, `bad block scalar header '${header}'`);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const explicit = m[3] ? Number(m[3]) : 0;
    this.consumeLine(pos);
    const base = Math.max(parentCol, 0);
    let indent = explicit ? (parentCol < 0 ? 0 : parentCol) + explicit : 0;
    const body: string[] = [];
    let i = this.next;
    for (; i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      const lead = line.length - line.trimStart().length;
      if (line.trim() === '') {
        body.push(line.length > indent && indent > 0 ? line.slice(indent) : '');
        continue;
      }
      if (!indent) {
        if (lead <= parentCol || (parentCol < 0 && lead < base)) break;
        indent = lead;
      }
      if (lead < indent) break;
      if (line.slice(0, indent).includes('\t')) this.fail(i, 'tabs are not allowed in indentation');
      body.push(line.slice(indent));
    }
    // Trailing blank lines belong to the scalar only for chomping; the parser resumes after content.
    let end = body.length;
    while (end > 0 && (body[end - 1] ?? '').trim() === '') end--;
    this.next = i - (body.length - end);
    const content = body.slice(0, end);
    const trailing = body.length - end;
    let text: string;
    if (!folded) {
      text = content.join('\n');
    } else {
      text = '';
      let blanks = 0;
      let prevMore = true; // so the first line gets no separator
      let started = false;
      for (const line of content) {
        if (line === '' || (line.trim() === '' && !/^[ \t]/.test(line))) {
          blanks++;
          continue;
        }
        const more = /^[ \t]/.test(line);
        if (!started) text += '\n'.repeat(blanks);
        else if (!more && !prevMore) text += blanks ? '\n'.repeat(blanks) : ' ';
        else text += '\n' + '\n'.repeat(blanks);
        text += line;
        blanks = 0;
        prevMore = more;
        started = true;
      }
    }
    if (content.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }

  private flow(pos: Pos): unknown {
    const raw = this.text(pos);
    const reader = new FlowReader(raw, pos, this);
    const value = reader.value();
    const after = raw.slice(reader.index).trim();
    if (after !== '' && !after.startsWith('#')) this.fail(pos, 'unexpected text after a flow collection');
    this.consumeLine(pos);
    return value;
  }

  // Exposed for the helpers below.
  error(pos: Pos | number, message: string): never {
    return this.fail(pos, message);
  }
}

/** One-line flow collections: `[a, 'b', [c]]`, `{a: 1, b: [x]}`. */
class FlowReader {
  index = 0;
  private readonly raw: string;
  private readonly pos: Pos;
  private readonly parser: Parser;
  constructor(raw: string, pos: Pos, parser: Parser) {
    this.raw = raw;
    this.pos = pos;
    this.parser = parser;
  }

  private ws(): void {
    while (this.raw[this.index] === ' ' || this.raw[this.index] === '\t') this.index++;
  }

  private fail(message: string): never {
    return this.parser.error(this.pos, message);
  }

  value(): unknown {
    this.ws();
    const c = this.raw[this.index];
    if (c === undefined || c === '#') this.fail('multi-line flow collections are not supported');
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === "'" || c === '"') {
      const close = findClose(this.raw, this.index + 1, c);
      if (close < 0) this.fail('multi-line flow collections are not supported');
      const inner = this.raw.slice(this.index + 1, close);
      this.index = close + 1;
      return c === "'" ? inner.replaceAll("''", "'") : unescapeDouble(inner, this.pos.line, this.parser);
    }
    const why = UNSUPPORTED_START[c];
    if (why && c !== ']' && c !== '}' && c !== ',') this.fail(why);
    const m = /^(?:[^,[\]{}#:\s]|:(?=[^\s,[\]{}])|[ \t]+(?=[^\s#,[\]{}:])|[ \t]+:(?=[^\s,[\]{}]))*/.exec(this.raw.slice(this.index));
    const text = m?.[0] ?? '';
    if (text === '') this.fail(`unexpected '${c}' in a flow collection`);
    this.index += text.length;
    return resolvePlain(text.trim());
  }

  private seq(): unknown[] {
    this.index++;
    const items: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.raw[this.index] === ']') {
        this.index++;
        return items;
      }
      items.push(this.value());
      this.ws();
      const c = this.raw[this.index];
      if (c === ',') this.index++;
      else if (c !== ']') this.fail(c === undefined || c === '#' ? 'multi-line flow collections are not supported' : `expected , or ] in a flow sequence`);
    }
  }

  private map(): YamlMap {
    this.index++;
    const map: YamlMap = Object.create(null) as YamlMap;
    for (;;) {
      this.ws();
      if (this.raw[this.index] === '}') {
        this.index++;
        return map;
      }
      const keyStart = this.raw[this.index];
      if (keyStart === '[' || keyStart === '{') this.fail('collection keys are not supported');
      const key = this.value();
      this.ws();
      let value: unknown = null;
      if (this.raw[this.index] === ':') {
        this.index++;
        this.ws();
        const c = this.raw[this.index];
        if (c !== ',' && c !== '}') value = this.value();
      }
      setKey(map, key, value);
      this.ws();
      const c = this.raw[this.index];
      if (c === ',') this.index++;
      else if (c !== '}') this.fail(c === undefined || c === '#' ? 'multi-line flow collections are not supported' : 'expected , or } in a flow mapping');
    }
  }
}

// ---------------------------------------------------------------- helpers

const KEY_IDS = new WeakMap<YamlMap, Map<string, string>>();

/**
 * Stores a value under str(key), the way a Python dict built by PyYAML and then read with str(k)
 * behaves: a later duplicate key wins, and keys Python treats as equal (1, 1.0 and true) share the
 * first one's slot.
 */
function setKey(map: YamlMap, key: unknown, value: unknown): void {
  let ids = KEY_IDS.get(map);
  if (!ids) {
    ids = new Map();
    KEY_IDS.set(map, ids);
  }
  const id = typeof key === 'number' || typeof key === 'boolean' ? `n:${Number(key)}` : `${typeof key}:${pyStr(key)}`;
  const name = ids.get(id) ?? pyStr(key);
  ids.set(id, name);
  map[name] = value;
}

function isDash(text: string): boolean {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

/** A `---` or `...` document marker at column 0, which ends every block. */
function atMarker(pos: Pos, text: string): boolean {
  return pos.col === 0 && (isMarker(text, '---') || isMarker(text, '...'));
}

function isMarker(text: string, marker: string): boolean {
  return text === marker || text.startsWith(`${marker} `) || text.startsWith(`${marker}\t`);
}

/** Cuts a ` #` comment off a plain value; `ended` says a comment was found. */
function cutComment(text: string): { text: string; ended: boolean } {
  const m = /(^|[ \t])#/.exec(text);
  if (!m) return { text, ended: false };
  return { text: text.slice(0, m.index), ended: true };
}

function checkPlainLine(text: string, pos: Pos, parser: Parser): void {
  if (/:[ \t]/.test(text) || /:$/.test(text.trimEnd())) parser.error(pos, 'a plain value cannot contain `: `; quote it');
}

interface KeySplit {
  key: string;
  quoted: boolean;
  valueOffset: number; // from the start of the text to the first character after `:` and spaces
}

/** If text starts with `key:` (followed by a space or the end of the line), the key and where the value starts. */
function splitKey(text: string, pos: Pos, parser: Parser): KeySplit | null {
  const first = text[0];
  if (first === '[' || first === '{') return null; // a flow collection; `[a]: b` keys fail in flow()
  if (first === "'" || first === '"') {
    const close = findClose(text, 1, first);
    if (close < 0) return null;
    const m = /^[ \t]*:(?=[ \t]|$)[ \t]*/.exec(text.slice(close + 1));
    if (!m) return null;
    const inner = text.slice(1, close);
    const key = first === "'" ? inner.replaceAll("''", "'") : unescapeDouble(inner, pos.line, parser);
    return { key, quoted: true, valueOffset: close + 1 + m[0].length };
  }
  const m = /:(?=[ \t]|$)/.exec(text);
  if (!m) return null;
  const keyText = text.slice(0, m.index);
  if (/(^|[ \t])#/.test(keyText)) return null; // the colon is inside a comment
  const key = keyText.trimEnd();
  if (key === '') parser.error(pos, 'empty mapping key');
  const c = key[0] ?? '';
  if (c === '[' || c === '{') parser.error(pos, 'flow collections as keys are not supported');
  const why = UNSUPPORTED_START[c];
  if (why) parser.error(pos, why);
  if (c === '|' || c === '>') return null;
  const gap = /^[ \t]*/.exec(text.slice(m.index + 1))?.[0].length ?? 0;
  return { key, quoted: false, valueOffset: m.index + 1 + gap };
}

/** Index of the closing quote at or after start, honouring '' and \" escapes; -1 if none on this line. */
function findClose(text: string, start: number, quote: string): number {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === '\\') {
      i++;
      continue;
    }
    if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
};
const HEX_LENGTH: Record<string, number> = { x: 2, u: 4, U: 8 };

function unescapeDouble(text: string, line: number, parser: Parser): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[++i] ?? '';
    const simple = ESCAPES[e];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const n = HEX_LENGTH[e];
    const hex = n ? text.slice(i + 1, i + 1 + n) : '';
    if (!n || !new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) parser.error(line, `unknown escape \\${e} in a double-quoted value`);
    out += String.fromCodePoint(Number.parseInt(hex, 16));
    i += n;
  }
  return out;
}

// PyYAML's implicit resolvers (YAML 1.1), applied to plain scalars only.
const NULL_RE = /^(?:~|null|Null|NULL|)$/;
const BOOL_RE = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const INT_RE = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT_RE = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const TIMESTAMP_RE = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

export function resolvePlain(text: string): unknown {
  if (NULL_RE.test(text)) return null;
  if (BOOL_RE.test(text)) return /^(?:yes|true|on)$/i.test(text);
  if (INT_RE.test(text)) return parseInt11(text);
  if (FLOAT_RE.test(text)) return parseFloat11(text);
  if (TIMESTAMP_RE.test(text)) return new YamlTimestamp(text);
  return text;
}

function parseInt11(text: string): number {
  let t = text.replaceAll('_', '');
  let sign = 1;
  if (t[0] === '-' || t[0] === '+') {
    if (t[0] === '-') sign = -1;
    t = t.slice(1);
  }
  if (t === '0') return 0;
  if (t.startsWith('0b')) return sign * Number.parseInt(t.slice(2), 2);
  if (t.startsWith('0x')) return sign * Number.parseInt(t.slice(2), 16);
  if (t.startsWith('0')) return sign * Number.parseInt(t.slice(1), 8);
  if (t.includes(':')) return sign * t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return sign * Number(t);
}

function parseFloat11(text: string): number {
  let t = text.replaceAll('_', '').toLowerCase();
  let sign = 1;
  if (t[0] === '-' || t[0] === '+') {
    if (t[0] === '-') sign = -1;
    t = t.slice(1);
  }
  if (t === '.inf') return sign * Infinity;
  if (t === '.nan') return Number.NaN;
  if (t.includes(':')) return sign * t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return sign * Number(t);
}
