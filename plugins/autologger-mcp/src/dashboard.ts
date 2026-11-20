// annotate's session dashboards: the built-in "session overview" template, and a static pre-check of
// any dashboard source against autologger's custom-dashboard save rules (dashboardRules.ts).
//
// The template reads everything it shows at runtime through the dashboard hooks (useSession,
// useEvents, useTopics, useWikiPages): no session content is ever written into its source. The one
// value put into the file, the heading, goes into a single `DATA` constant as JSON (with <, >, &,
// U+2028 and U+2029 escaped), never into JSX or code, so the code a dashboard runs does not depend on
// any text. autologger's save_dashboard validates the source again when it is saved.
import { DENIED_ELEMENTS, DENIED_GLOBALS, IMPORT_ALLOWLIST, MAX_IMPORT_SPECIFIERS, MAX_TITLE_CHARS, MAX_TSX_CHARS } from './dashboardRules.ts';

/** The name a plan gives the built-in template. */
export const OVERVIEW_TEMPLATE = 'session-overview';
export const DEFAULT_OVERVIEW_TITLE = 'Session overview';

/** The imports of the template; every one is in autologger's allowlist (checked by the tests). */
export const OVERVIEW_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  react: ['useMemo'],
  '@autologger/dashboard': ['useSession', 'useEvents', 'useTopics', 'useWikiPages', 'formatDuration', 'Unavailable'],
  '@/components/ui/badge': ['Badge'],
  '@/components/ui/card': ['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle'],
};

const IMPORT_LINES = Object.entries(OVERVIEW_IMPORTS)
  .map(([from, names]) => `import { ${names.join(', ')} } from '${from}';`)
  .join('\n');

/** The fixed code of the overview; `__DATA__` is replaced with the JSON literal of its data. */
export const OVERVIEW_TSX = `// Made by autologger-mcp annotate: a session overview - its events by category, its topics in time
// order and its wiki pages, all read at runtime through the dashboard hooks. DATA holds only the
// heading, as JSON; the code does not depend on it.
${IMPORT_LINES}

const DATA = __DATA__;

const TAKE_ROW = /^Recording \\d+ (Started|Stopped)$/;

export default function SessionOverview() {
  const session = useSession();
  const events = useEvents({ all: true });
  const topics = useTopics({ all: true });
  const pages = useWikiPages({ all: true });
  const groups = useMemo(() => {
    const byLabel = new Map();
    for (const e of events.data ?? []) {
      if (String(e.category).toLowerCase() === 'internal' && TAKE_ROW.test(String(e.message))) continue;
      const label = e.category_label || e.category;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(e);
    }
    return [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
  }, [events.data]);
  const ordered = useMemo(
    () => [...(topics.data ?? [])].sort((a, b) => String(a.session_time).localeCompare(String(b.session_time)) || a.ordinal - b.ordinal),
    [topics.data],
  );
  const heading = DATA.title || (session.data ? session.data.title : '');
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">{heading}</h1>
        {session.data ? <p className="text-sm text-muted-foreground">{session.data.title} ({session.data.date})</p> : null}
        {session.error ? <Unavailable label="Session" reason={session.error} /> : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Events by category</CardTitle>
          <CardDescription>{events.loading ? 'Loading...' : groups.reduce((n, g) => n + g[1].length, 0) + ' events'}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {events.error ? <Unavailable label="Events" reason={events.error} /> : null}
          {groups.map(([label, rows]) => (
            <section key={label} className="flex flex-col gap-1">
              <h3 className="flex items-center gap-2 font-medium">
                {label} <Badge variant="secondary">{rows.length}</Badge>
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {rows.map((e) => (
                  <li key={e.event_id} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-muted-foreground">{e.timecode ?? ''}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Topics</CardTitle>
          <CardDescription>{topics.loading ? 'Loading...' : ordered.length + ' topics, in time order'}</CardDescription>
        </CardHeader>
        <CardContent>
          {topics.error ? <Unavailable label="Topics" reason={topics.error} /> : null}
          <ol className="flex flex-col gap-1 text-sm">
            {ordered.map((t) => (
              <li key={t.id} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {t.session_time} ({formatDuration(t.duration_sec)})
                </span>
                <span>{t.summary}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Wiki pages</CardTitle>
          <CardDescription>{pages.loading ? 'Loading...' : (pages.data ?? []).length + ' pages linked to this session'}</CardDescription>
        </CardHeader>
        <CardContent>
          {pages.error ? <Unavailable label="Wiki pages" reason={pages.error} /> : null}
          <ul className="flex flex-col gap-1 text-sm">
            {(pages.data ?? []).map((p) => (
              <li key={p.page_id} className="flex items-center gap-2">
                <Badge variant="outline">{p.kind}</Badge>
                <span>{p.title}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
`;

/** JSON as a JS expression, with the characters that could end or confuse a surrounding context escaped. */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A dashboard title as autologger takes it: control characters removed, trimmed, at most 200 characters. */
export function cleanTitle(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TITLE_CHARS).trim();
}

/** The overview template's source with `title` as its heading (as escaped JSON data). */
export function overviewTsx(title: string): string {
  // A function replacement, so `$&`, `$'` and the like in the title are not replacement patterns.
  return OVERVIEW_TSX.replace('__DATA__', () => jsonLiteral({ title }));
}

/** Why a dashboard title is refused, or undefined. */
export function titleProblem(title: unknown): string | undefined {
  if (typeof title !== 'string' || title.trim() === '') return 'a dashboard needs a title';
  if (title.length > MAX_TITLE_CHARS) return `the dashboard title is over ${MAX_TITLE_CHARS} characters`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f]/.test(title)) return 'the dashboard title has control characters';
  return undefined;
}

/**
 * The source with comments blanked (`code`), and with comments and string and template literals
 * blanked too (`bare`); line and column positions are kept. A heuristic for the pre-check only: an
 * apostrophe in JSX text starts a "string" that ends at the line's end.
 */
function blanked(source: string): { code: string; bare: string } {
  let code = '';
  let bare = '';
  let i = 0;
  const keep = (c: string, inString: boolean): void => {
    code += c;
    bare += inString && c !== '\n' ? ' ' : c;
  };
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        code += ' ';
        bare += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) {
        const ch = source[i] === '\n' ? '\n' : ' ';
        code += ch;
        bare += ch;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      keep(c, false);
      i++;
      while (i < source.length) {
        const ch = source[i] as string;
        if (ch === '\\' && i + 1 < source.length) {
          keep(ch, true);
          keep(source[i + 1] as string, true);
          i += 2;
          continue;
        }
        if (ch === c) {
          keep(ch, false);
          i++;
          break;
        }
        if (ch === '\n' && c !== '`') break;
        keep(ch, true);
        i++;
      }
      continue;
    }
    keep(c, false);
    i++;
  }
  return { code, bare };
}

/** A 1-based line lookup for `text`, by binary search over its line starts (linear to build). */
function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

type ImportStatement = { index: number; clause: string; from: string };

/**
 * The static `import <clause> from '<module>'` statements, one per `import` keyword in `bare`, or
 * the index of the first keyword that does not start one. Scanned by hand, not by one regex, so
 * it stays linear on any input (a long run of spaces or a comment after `import` included).
 */
function importStatements(code: string, bare: string): { statements: ImportStatement[]; bad?: number } {
  // For each position, the index of the next character that ends an import clause in `bare`.
  const nextStop = new Array<number>(bare.length + 1).fill(bare.length);
  for (let i = bare.length - 1; i >= 0; i--) nextStop[i] = ";'\"`".includes(bare[i] as string) ? i : (nextStop[i + 1] as number);
  const statements: ImportStatement[] = [];
  const keywords = [...bare.matchAll(/(?<![\w$.])import(?![\w$])/g)].map((k) => k.index);
  for (const [n, at] of keywords.entries()) {
    let before = at - 1;
    while (before >= 0 && (code[before] === ' ' || code[before] === '\t')) before--;
    const starts = before < 0 || code[before] === ';' || code[before] === '\n';
    const stop = nextStop[at + 6] as number;
    const quote = bare[stop];
    // A clause that runs into the next keyword is not one; this also keeps every slice below to
    // text between two keywords, so the whole scan is linear.
    if (!starts || (keywords[n + 1] ?? Infinity) < stop || (quote !== "'" && quote !== '"')) return { statements, bad: at };
    const head = code.slice(at + 6, stop);
    const trimmed = head.trimEnd();
    const clause = trimmed.slice(0, -4).trim();
    // The module name: up to the closing quote, on the same line (string contents hold no keyword).
    let end = stop + 1;
    while (end < code.length && code[end] !== quote && code[end] !== '\n' && code[end] !== "'" && code[end] !== '"') end++;
    const from = code.slice(stop + 1, end);
    if (code[end] !== quote || !isSpace(head[0]) || !trimmed.endsWith('from') || !isSpace(trimmed[trimmed.length - 5]) || clause === '' || from === '') {
      return { statements, bad: at };
    }
    statements.push({ index: at, clause, from });
  }
  return { statements };
}

/**
 * Problems with a dashboard source under autologger's save rules, checked statically (empty when
 * none): its size, imports (static, from the allowlist, at most 60 bindings), exactly one export (a
 * default function component), no denied element, no raw HTML or string event handler, and no
 * reference to a denied global.
 */
export function dashboardProblems(tsx: string): string[] {
  // Nothing below runs on an oversized source, so the scans' cost stays bounded by autologger's limit.
  if (tsx.length > MAX_TSX_CHARS) return [`the source is ${tsx.length} characters, over autologger's ${MAX_TSX_CHARS}`];
  const problems: string[] = [];
  if (tsx.includes('\0')) problems.push('the source contains a NUL character');
  const { code, bare } = blanked(tsx);
  const lineOf = lineIndex(code);

  const { statements, bad } = importStatements(code, bare);
  if (bad !== undefined) problems.push(`line ${lineOf(bad)}: only static "import ... from '<module>'" statements are allowed (no import(), import.meta or side-effect imports)`);
  if (/(?<![\w$.])require\s*\(/.test(bare)) problems.push('require() is not allowed');
  let bindings = 0;
  for (const { index, clause, from } of statements) {
    const line = lineOf(index);
    const allowed = IMPORT_ALLOWLIST[from];
    if (allowed === undefined) {
      problems.push(`line ${line}: '${from}' is not a module a dashboard may import`);
      continue;
    }
    const m = /^(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(clause);
    if (m === null || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
      problems.push(`line ${line}: cannot read the import clause '${clause}'`);
      continue;
    }
    if ((m[1] !== undefined || m[3] !== undefined) && from !== 'react') problems.push(`line ${line}: only named imports are allowed from '${from}'`);
    if (m[1] !== undefined) bindings++;
    if (m[3] !== undefined) bindings++;
    for (const part of (m[2] ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '')) {
      const name = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.exec(part)?.[1];
      bindings++;
      if (name === undefined || !allowed.includes(name)) problems.push(`line ${line}: '${part}' is not allowed from '${from}'`);
    }
  }
  if (bindings > MAX_IMPORT_SPECIFIERS) problems.push(`${bindings} imported bindings, over autologger's ${MAX_IMPORT_SPECIFIERS}`);

  const exports = [...bare.matchAll(/(?<![\w$.])export(?![\w$])/g)];
  if (exports.length !== 1 || !/(?<![\w$.])export\s+default\s+function\b/.test(bare)) {
    problems.push('the source must have exactly one export: "export default function <Name>() { ... }"');
  }
  for (const m of bare.matchAll(/<\/?([A-Za-z][\w.:-]*)/g)) {
    const tag = (m[1] ?? '').toLowerCase().split(':').pop() ?? '';
    if ((DENIED_ELEMENTS as readonly string[]).includes(tag)) problems.push(`line ${lineOf(m.index)}: the element <${m[1]}> is not allowed`);
  }
  if (/dangerouslySetInnerHTML|srcDoc/i.test(bare)) problems.push('dangerouslySetInnerHTML and srcDoc are not allowed');
  if (/\son[A-Z]\w*=\s*['"]/.test(code)) problems.push('an event handler given as a string is not allowed');
  for (const name of DENIED_GLOBALS) {
    // A free reference: not a property (`.name`), not part of a longer name, not an object key.
    const m = new RegExp(`(?<![\\w$.])${name}(?![\\w$])(?!\\s*:(?!:))`).exec(bare);
    if (m !== null) problems.push(`line ${lineOf(m.index)}: ${name} is not allowed`);
  }
  return problems;
}
