// check-links: finds the wiki-link mistakes agents make in autologger wiki bodies.
//
// autologger renders `[label](wiki:<page_id>)` and `[quote](cite:<session_id>@<seconds>)` links
// (packages/contract/src/wikiLinks.ts in autologger). It does not render `[[Title]]`, and it refuses
// a body whose `wiki:`/`cite:` URL is off the exact lower-case grammar:
//   cite:<[A-Za-z0-9_-]{1,64}>@<\d+(\.\d{1,3})?>
//   wiki:<[A-Za-z0-9_-]{1,64}>
// This is a line-oriented approximation of the CommonMark parse autologger uses (no dependency):
// fenced code blocks, indented code blocks and code spans are skipped; inline links (plain and
// `<...>` destinations, backslash escapes decoded), reference definitions and autolinks are checked.

export interface LinkProblem {
  line: number;
  column: number;
  kind: 'double-bracket' | 'invalid-target';
  text: string;
  message: string;
}

const CITE_RE = /^cite:[A-Za-z0-9_-]{1,64}@\d+(?:\.\d{1,3})?$/;
const WIKI_RE = /^wiki:[A-Za-z0-9_-]{1,64}$/;
const SCHEME_RE = /^(cite|wiki):/i;

/** Whether a URL is a `wiki:`/`cite:` URL (any case) and whether it matches the exact grammar. */
export function classifyUrl(url: string): 'valid' | 'invalid' | 'other' {
  if (!SCHEME_RE.test(url)) return 'other';
  return CITE_RE.test(url) || WIKI_RE.test(url) ? 'valid' : 'invalid';
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/** Replaces code spans in a block's text with spaces, keeping offsets (and newlines). */
function maskCodeSpans(text: string): string {
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '\\' && chars[i + 1] === '`') {
      i += 2;
      continue;
    }
    if (chars[i] !== '`') {
      i++;
      continue;
    }
    let run = 0;
    while (chars[i + run] === '`') run++;
    // Find a closing run of exactly the same length.
    let j = i + run;
    let close = -1;
    while (j < chars.length) {
      if (chars[j] === '`') {
        let r = 0;
        while (chars[j + r] === '`') r++;
        if (r === run) {
          close = j;
          break;
        }
        j += r;
      } else {
        j++;
      }
    }
    if (close === -1) {
      i += run;
      continue;
    }
    for (let k = i; k < close + run; k++) if (chars[k] !== '\n') chars[k] = ' ';
    i = close + run;
  }
  return chars.join('');
}

function unescape(dest: string): string {
  return dest.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The destination of an inline link starting just after `](`, or undefined if there is none. When
 * the parentheses hold more than a destination and a title (`[x](wiki:Jane Doe)`), CommonMark
 * renders no link at all; the whole text up to `)` is returned so a wiki:/cite: one is reported.
 */
function inlineDestination(text: string, start: number): string | undefined {
  const dest = plainDestination(text, start);
  if (dest === undefined) return undefined;
  let i = dest.end;
  while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++;
  const next = text[i];
  if (next === undefined || next === ')' || next === '"' || next === "'" || next === '(') return dest.value;
  const close = text.indexOf(')', i);
  return text.slice(dest.start, close === -1 ? text.length : close).replace(/\s+/g, ' ');
}

function plainDestination(text: string, start: number): { value: string; start: number; end: number } | undefined {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end === -1) return undefined;
    const inner = text.slice(i + 1, end);
    return inner.includes('\n') ? undefined : { value: unescape(inner), start: i, end: end + 1 };
  }
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '(') depth++;
    if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  return { value: unescape(text.slice(i, j)), start: i, end: j };
}

/** Checks a Markdown body. Lines and columns are 1-based. */
export function checkLinks(body: string): LinkProblem[] {
  const lines = body.split(/\r?\n/);
  const problems: LinkProblem[] = [];
  let fence: { char: string; length: number } | undefined;
  let block: { start: number; lines: string[] } | undefined;
  let previousBlank = true;
  let inIndentedCode = false;
  let lastContentWasList = false;

  const flush = (): void => {
    if (block !== undefined) checkBlock(block.lines.join('\n'), block.start, problems);
    block = undefined;
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (fence !== undefined) {
      const m = FENCE_RE.exec(line);
      if (m?.[1] !== undefined && m[1][0] === fence.char && m[1].length >= fence.length && (m[2] ?? '').trim() === '') fence = undefined;
      previousBlank = false;
      return;
    }
    const fenceOpen = FENCE_RE.exec(line);
    if (fenceOpen?.[1] !== undefined && !(fenceOpen[1][0] === '`' && (fenceOpen[2] ?? '').includes('`'))) {
      flush();
      fence = { char: fenceOpen[1][0] ?? '`', length: fenceOpen[1].length };
      previousBlank = false;
      inIndentedCode = false;
      return;
    }
    if (line.trim() === '') {
      flush();
      previousBlank = true;
      return;
    }
    const indented = /^(?: {4}|\t)/.test(line);
    if (indented && (inIndentedCode || (previousBlank && block === undefined && !lastContentWasList))) {
      inIndentedCode = true;
      previousBlank = false;
      return;
    }
    inIndentedCode = false;
    if (!indented) lastContentWasList = LIST_ITEM_RE.test(line);
    previousBlank = false;
    if (block === undefined) block = { start: lineNo, lines: [] };
    block.lines.push(line);
  });
  flush();
  return problems.sort((a, b) => a.line - b.line || a.column - b.column);
}

function checkBlock(raw: string, startLine: number, problems: LinkProblem[]): void {
  const text = maskCodeSpans(raw);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const where = (offset: number): { line: number; column: number } => {
    let l = 0;
    while (l + 1 < lineStarts.length && (lineStarts[l + 1] ?? Infinity) <= offset) l++;
    return { line: startLine + l, column: offset - (lineStarts[l] ?? 0) + 1 };
  };

  for (const m of text.matchAll(/(?<!\\)\[\[([^\[\]\n]+)\]\]/g)) {
    const inner = (m[1] ?? '').trim();
    problems.push({
      ...where(m.index),
      kind: 'double-bracket',
      text: m[0],
      message: `'${m[0]}' is not a link in autologger; write [${inner}](wiki:<page_id>) with the page's id (find it with list_wiki_pages), or [quote](cite:<session_id>@<seconds>) for a transcript quote`,
    });
  }

  const report = (url: string, offset: number, shown: string): void => {
    if (classifyUrl(url) !== 'invalid') return;
    problems.push({
      ...where(offset),
      kind: 'invalid-target',
      text: shown,
      message: `'${url}' does not match wiki:<page_id> or cite:<session_id>@<seconds> (ids are 1-64 of A-Z a-z 0-9 _ -, seconds like 120 or 120.5, scheme in lower case)`,
    });
  };

  // Inline links: `](` then a destination.
  for (const m of text.matchAll(/\]\(/g)) {
    const dest = inlineDestination(text, m.index + 2);
    if (dest !== undefined) report(dest, m.index + 2, dest);
  }
  // Reference definitions: `[label]: destination` at the start of a line.
  for (const m of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    const rawDest = m[1] ?? '';
    const dest = unescape(rawDest.startsWith('<') ? rawDest.slice(1, -1) : rawDest);
    report(dest, m.index + m[0].length - rawDest.length, dest);
  }
  // Autolinks: `<wiki:...>` / `<cite:...>`.
  for (const m of text.matchAll(/(?<!\]\()<((?:cite|wiki):[^\s<>]*)>/gi)) {
    report(m[1] ?? '', m.index + 1, m[1] ?? '');
  }
}

/** What a `wiki:`/`cite:` link's id becomes: a new id, or undefined to leave the link as it is. */
export interface LinkResolver {
  /** A source page id: the target page id, or undefined. */
  page: (id: string) => string | undefined;
  /** A source session id: the target session id, or undefined. */
  session: (id: string) => string | undefined;
}

export interface RewriteResult {
  body: string;
  /** Each link left unchanged because the resolver had no target for it, as written (`wiki:p1`). */
  unresolved: string[];
}

// A wiki:/cite: URL where a link destination starts: after `](` (optionally `<`), after a reference
// definition's `]:`, or as an autolink `<...>`. The id ends at a character the grammar excludes.
const LINK_TARGET_RE =
  /(\]\([ \t\n]*<?|^ {0,3}\[[^\]\n]+\]:[ \t]*<?|<)(wiki|cite):([A-Za-z0-9_-]{1,64})(@\d+(?:\.\d{1,3})?)?(?![A-Za-z0-9_@-])/gm;

/**
 * Rewrites the ids of the `wiki:<page_id>` and `cite:<session_id>@<seconds>` link destinations in a
 * Markdown body through `resolve`. Only the id changes; links the resolver has no target for, and
 * text that is not a link destination, are left as they are.
 */
export function rewriteLinks(body: string, resolve: LinkResolver): RewriteResult {
  const unresolved: string[] = [];
  const out = body.replace(LINK_TARGET_RE, (whole, lead: string, scheme: string, id: string, at: string | undefined) => {
    if (scheme === 'wiki' && at !== undefined) return whole;
    if (scheme === 'cite' && at === undefined) return whole;
    const target = scheme === 'wiki' ? resolve.page(id) : resolve.session(id);
    if (target === undefined) {
      unresolved.push(`${scheme}:${id}${at ?? ''}`);
      return whole;
    }
    return `${lead}${scheme}:${target}${at ?? ''}`;
  });
  return { body: out, unresolved };
}

/** A `wiki:` or `cite:` inline link of a body, on the exact grammar. */
export type LinkTarget =
  | { kind: 'wiki'; page_id: string; label: string; index: number }
  | { kind: 'cite'; session_id: string; seconds: number; label: string; index: number };

// `[label](wiki:<id>)` / `[label](cite:<id>@<seconds>)`, with an optional `<...>` destination and title.
const INLINE_TARGET_RE =
  /\[((?:\\.|[^\[\]\\])*)\]\([ \t\n]*<?(wiki|cite):([A-Za-z0-9_-]{1,64})(?:@(\d+(?:\.\d{1,3})?))?>?(?:[ \t\n]+(?:"[^"]*"|'[^']*'))?[ \t\n]*\)/g;

/** Replaces fenced code blocks (``` or ~~~) with blank lines, keeping offsets. */
function maskFences(body: string): string {
  const lines = body.split('\n');
  let fence: { char: string; length: number } | undefined;
  return lines
    .map((line) => {
      const m = FENCE_RE.exec(line);
      if (fence !== undefined) {
        if (m?.[1] !== undefined && m[1][0] === fence.char && m[1].length >= fence.length && (m[2] ?? '').trim() === '') fence = undefined;
        return ' '.repeat(line.length);
      }
      if (m?.[1] !== undefined && !(m[1][0] === '`' && (m[2] ?? '').includes('`'))) {
        fence = { char: m[1][0] ?? '`', length: m[1].length };
        return ' '.repeat(line.length);
      }
      return line;
    })
    .join('\n');
}

/**
 * The `wiki:` and `cite:` inline links of a Markdown body, in order, outside code blocks and code
 * spans; `index` is the link's offset in the body. Like checkLinks, a close approximation of the
 * CommonMark parse autologger uses: reference-style links are not followed.
 */
export function linkTargets(body: string): LinkTarget[] {
  const text = maskCodeSpans(maskFences(body));
  const out: LinkTarget[] = [];
  for (const m of text.matchAll(INLINE_TARGET_RE)) {
    const label = unescape(m[1] ?? '').replace(/\s+/g, ' ').trim();
    const id = m[3] ?? '';
    if (m[2] === 'wiki' && m[4] === undefined) out.push({ kind: 'wiki', page_id: id, label, index: m.index });
    if (m[2] === 'cite' && m[4] !== undefined) out.push({ kind: 'cite', session_id: id, seconds: Number(m[4]), label, index: m.index });
  }
  return out;
}

/** `cite:<session_id>@<seconds>` on autologger's grammar, or null when the id or time cannot be written so. */
export function citeUrl(sessionId: string, seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const url = `cite:${sessionId}@${String(Math.round(seconds * 1000) / 1000)}`;
  return CITE_RE.test(url) ? url : null;
}
