// Redaction, length caps, normalisation and signatures: everything that decides what text is stored
// and which occurrences count as the same issue. Pattern-based, because unlike autologger-mcp's and
// autologger-dev's scrubbers (which replace secret values they already hold) this CLI never sees the
// secrets themselves, only text that might contain them. Over-redacting is the safe failure.
import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';
export const SUMMARY_MAX = 200;
export const DETAIL_MAX = 2000;

/** Key names whose values are treated as secrets in `key=value`, `key: value` and `--key value`. */
const SECRET_KEY = /(secret|token|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|(^|[_.-])sid$|^sid$|^auth$|authorization|session[_-]?id|(^|[_.-])session$|jwt)/i;

/** Set-Cookie attributes: their values describe the cookie and are not secret. */
const COOKIE_ATTRIBUTE = /^(path|domain|expires|max-age|samesite|secure|httponly|partitioned|priority)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Values left alone: empty, or exactly the marker, so a second pass changes nothing. A value that only
 * starts with the marker (`[redacted]x`) is redacted again: a typed marker must not shield a secret. */
function keep(value: string): boolean {
  return value === '' || value === REDACTED;
}

/** A long run of token characters that looks random (mixes letters and digits) rather than a word. */
function looksRandom(text: string, needsCaseMix: boolean): boolean {
  const digit = /\d/.test(text);
  const lower = /[a-z]/.test(text);
  const upper = /[A-Z]/.test(text);
  return needsCaseMix ? digit && lower && upper : digit && (lower || upper);
}

/**
 * A Cookie or Set-Cookie header value with every cookie's value redacted. Attributes (`Path`,
 * `Secure`, ...) keep their values only in a `Set-Cookie:` header (`setCookie`): a request `Cookie:`
 * header has no attributes, so `Cookie: a=b; path=x` is a cookie named `path` and its value is
 * redacted. Only an exact `[redacted]` counts as already redacted, so anything after it on the line
 * (a cookie, or a bare word) is redacted too. `file` does not depend on this being stable once text is
 * appended to a redacted line: it checks each stored field on its own (see `draftFields` in advisor.ts).
 */
function redactCookies(value: string, setCookie: boolean): string {
  const attribute = (name: string): boolean => setCookie && COOKIE_ATTRIBUTE.test(name);
  return value
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      const raw = eq === -1 ? '' : part.slice(eq + 1);
      const v = raw.trim();
      if (eq === -1) return name === '' || name === REDACTED || attribute(name) ? part : part.replace(name, REDACTED);
      if (attribute(name) || v === '' || v === REDACTED) return part;
      return `${part.slice(0, eq + 1)}${raw.match(/^\s*/)?.[0] ?? ''}${REDACTED}`;
    })
    .join(';');
}

/**
 * A `key=value` / `key: value` key and its separator. Matching stops here, so a value is scanned too.
 * An unquoted key starts only where a run of key characters starts (the lookbehind), so a long word is
 * scanned once rather than from each of its characters; digits, `.` and `-` that lead the run are
 * skipped (`--password=x` has the key `password`). A quoted key starts at its quote whatever comes
 * before it (`{b'token': ...}`, `x"password"=...`). The separator stays on one line (`H` below: any
 * space but a line break, Unicode spaces such as NBSP included): a key at the end of a line does not
 * take the next line's first word as its value.
 */
const H = '[^\\S\\r\\n\\u2028\\u2029]';
const KEY_SEP = new RegExp(`(?:(["'])|(?<![A-Za-z0-9_.-]))[0-9.-]*([A-Za-z_][A-Za-z0-9_.-]*)\\1(${H}*[=:]${H}*)`, 'g');
/** A key whose quotes are escaped with backslashes, once or more (`{\"password\": ...}`, JSON logged
 * inside a JSON string), closed with the same escape it opens with. A run of backslashes is tried
 * from its start only (the lookbehind), so it is scanned once. */
const ESCAPED_KEY_SEP = new RegExp(`(?<!\\\\)(\\\\+["'])[0-9.-]*([A-Za-z_][A-Za-z0-9_.-]*)\\1(${H}*[=:]${H}*)`, 'g');
/** The value after a key: quoted (with an optional string prefix such as Python's `b'...'` or
 * `u'...'`), or a bare run of value characters, where a `]` ends it unless it closes a marker or more
 * value follows. Sticky: it is tried only right after a key's separator. */
const KEY_VALUE = /([bBuUrR]{0,2})(?:"([^"\n]*)"|'([^'\n]*)')|((?:\[redacted\]|\](?=[^\s"'&;,)}\]])|[^\s"'&;,)}\]])+)/y;
/** The opening of a quoted value whose quotes are escaped (`\"abc\"`): an optional string prefix, the
 * escape (one or more backslashes) and the quote. Sticky: it is tried only right after a key's separator. */
const ESCAPED_OPEN = /([bBuUrR]{0,2})(\\+)(["'])/y;

/** What may follow a value that ends as JSON would: nothing, a space, `,`, `}`, `]` or `)`. */
const VALUE_END = /^(?:$|[\s,}\])])/;

/** A JSON number. */
const JSON_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Spaces on the line, then a `,` or `}`. Sticky. */
const COMMA_OR_BRACE = new RegExp(`${H}*[,}]`, 'y');

/**
 * Whether `part`, taken into a redacted value, holds nothing the other rules read before or after a
 * line join (`cleanSummary`, or `cleanDetail` dropping a control character): no separator (`=`, `:`),
 * no command end (`;`, `|`, `&`), no line break or other control character, no quote other than the
 * value's own `quote`, and no password command's name, which the `-p` rule reads up to the end of its
 * command, also across a `,` or `}`.
 */
function quiet(part: string, quote: string): boolean {
  return !/[=:;|&`\u0000-\u001f\u007f\u2028\u2029]/.test(part) && !part.includes(quote === '"' ? "'" : '"') && !PASSWORD_COMMAND_NAME.test(part);
}

/**
 * The escaped quoted value at `at` (`\"abc\"`, `\\\"abc\\\"`), redacted, with its length; or undefined
 * when there is none. With `n` backslashes before its opening quote, the value closes at the first
 * same quote with at least `n` backslashes before it, as before. When that quote is escaped one level
 * deeper (`2n + 1` backslashes, plus any pairs of literal ones: `{\"password\": \"a\\\"b\"}`), the
 * value goes on to the quote that does close it (`n` backslashes, plus pairs), but only when that
 * quote ends the value as JSON would (`VALUE_END`), the part read beyond the first quote is `quiet`,
 * and no password command's name comes before the value in the text (`commandBefore`): the longer
 * value holds fewer quotes, and the `-p` rule pairs the quotes after a command's name to find where
 * the command ends, also once `cleanSummary` has joined the lines. Otherwise the value ends at the
 * first quote, as before. One pass from `at` to the closing quote or the end of the line.
 *
 * With `plainKey` (a key whose own quotes are not escaped: `password: \"x\"`), the value ends at the
 * first quote, and counts only when it is not empty, holds no backslash, is `quiet` and ends as JSON
 * would; otherwise the caller reads the value as before (`KEY_VALUE`), since the other rules read
 * text there. Its opening escape becomes the marker, as before (`password: [redacted]"[redacted]\"`),
 * so that no escaped quote is left there for the escaped-key pass to close an outer value with.
 */
function escapedValue(text: string, at: number, plainKey: boolean, commandBefore: boolean): [string, number] | undefined {
  ESCAPED_OPEN.lastIndex = at;
  const open = ESCAPED_OPEN.exec(text);
  if (open === null) return undefined;
  const [opening, prefix = '', escape = '', quote = '"'] = open;
  const n = escape.length;
  const from = at + opening.length;
  const closes = (run: number): boolean => run >= n && (run - n) % (2 * n + 2) === 0;
  const deeper = (run: number): boolean => run > n && (run - 2 * n - 1) % (2 * n + 2) === 0;
  let first = -1;
  let firstRun = 0;
  let close = -1;
  let run = 0;
  for (let i = from; i < text.length && text[i] !== '\n'; i++) {
    const c = text[i];
    if (c === '\\') {
      run++;
      continue;
    }
    if (c === quote) {
      if (first === -1) {
        first = i;
        firstRun = run;
        if (plainKey || commandBefore) break;
      }
      if (!deeper(run)) {
        if (i !== first && closes(run)) close = i;
        break;
      }
    }
    run = 0;
  }
  if (first === -1 || firstRun < n) return undefined;
  const redacted = `${prefix}${escape}${quote}${REDACTED}${escape}${quote}`;
  if (close !== -1 && VALUE_END.test(text.slice(close + 1, close + 2)) && quiet(text.slice(first + 1, close), quote)) {
    return [redacted, close + 1 - at];
  }
  const content = text.slice(from, first - n);
  if (!plainKey) return [keep(content) ? text.slice(at, first + 1) : redacted, first + 1 - at];
  if (content === '' || content.includes('\\') || !quiet(content, quote) || !VALUE_END.test(text.slice(first + 1, first + 2))) return undefined;
  return [keep(content) ? text.slice(at, first + 1) : `${REDACTED}${quote}${REDACTED}${escape}${quote}`, first + 1 - at];
}

/**
 * Whether a bare value after an escaped key, ending at `end`, is redacted: a JSON number
 * (`{\"token\": 123456}`), or a value followed on its line by a `,` or `}` (`{\"password\": hunter2}`)
 * that is `quiet` (`\"sid\":=,` is a separator the cookie rule reads) and holds no backslash. Any
 * other bare value is left to the rules that read it.
 */
function bareEscapedValue(value: string, text: string, end: number): boolean {
  if (JSON_NUMBER.test(value)) return true;
  COMMA_OR_BRACE.lastIndex = end;
  return COMMA_OR_BRACE.test(text) && quiet(value, '"') && !value.includes('\\');
}

/**
 * `key=value`, `key: value` and `"key": "value"` with a secret-looking key: the value is redacted;
 * only an exact marker is kept, so `[redacted]x` is redacted again. One scan, left to right: after an
 * ordinary key the scan goes on inside its value, so `failed: password=x` and `error=token=abc` are
 * redacted, with no recursion and in linear time however many `a=a=...` segments a line holds.
 * `keySep` is `KEY_SEP` or `ESCAPED_KEY_SEP`; its groups are the key's opening quote, the key and the
 * separator. With `escaped`, a value may have escaped quotes, and a bare value is redacted only when
 * `bareEscapedValue` says so. After an ordinary key, an escaped value (`password: \"x\"`) is read
 * whole only when it holds nothing the other rules read (see `escapedValue`); otherwise it is read as
 * before.
 */
function scanKeyValues(text: string, keySep: RegExp, escaped: boolean): string {
  let out = '';
  let done = 0;
  const firstCommand = escaped ? text.search(PASSWORD_COMMAND_NAME) : -1;
  keySep.lastIndex = 0;
  for (let m = keySep.exec(text); m !== null; m = keySep.exec(text)) {
    const [head, q, key = '', sep = ''] = m;
    if (!isSecretKey(key)) continue;
    const at = m.index + head.length;
    // A `Cookie:` header on its line is the cookie rule's (above): its value is `name=[redacted]`.
    const cookieHeader = q === undefined && /^(set-)?cookie$/i.test(key) && /^[ \t]*:[ \t]*$/.test(sep);
    let replaced: string;
    let end: number;
    const quoted = cookieHeader ? undefined : escapedValue(text, at, !escaped, firstCommand !== -1 && firstCommand < at);
    if (quoted !== undefined) {
      end = at + quoted[1];
      keySep.lastIndex = end;
      replaced = quoted[0];
    } else {
      KEY_VALUE.lastIndex = at;
      const v = KEY_VALUE.exec(text);
      if (v === null) continue;
      const [value, prefix = '', dq, sq, bare = ''] = v;
      end = at + value.length;
      keySep.lastIndex = end;
      if (cookieHeader) continue;
      if (dq !== undefined) replaced = keep(dq) ? value : `${prefix}"${REDACTED}"`;
      else if (sq !== undefined) replaced = keep(sq) ? value : `${prefix}'${REDACTED}'`;
      else if (escaped && !bareEscapedValue(bare, text, end)) continue;
      else replaced = keep(bare) ? value : REDACTED;
    }
    out += text.slice(done, at) + replaced;
    done = end;
  }
  return out + text.slice(done);
}

function redactKeyValues(text: string): string {
  return scanKeyValues(text, KEY_SEP, false);
}

/**
 * The same for keys with escaped quotes, for quoted values only (escaped JSON quotes its strings),
 * run after every other rule so that it only adds to what they redact. In `redactKeyValues`'s place,
 * or with bare values, it would take text the rules after that read: in `{\"session\": mysql -p x}`
 * the value `mysql` is the name the `-p` rule looks for, and in `\"cookie\":Authorization=` the value
 * is a key whose value is on the next line until `cleanSummary` joins the lines. Escaped values are
 * read here only, for the same reason: `secret:\"\"session"=x` is a key `"session"` to the other rules.
 */
function redactEscapedKeyValues(text: string): string {
  return scanKeyValues(text, ESCAPED_KEY_SEP, true);
}

/**
 * Commands whose `-p` takes a password: the MySQL and MariaDB clients and tools, the MongoDB shell and
 * tools, sshpass, cqlsh (Cassandra), rabbitmqadmin, rdesktop, and the 7-Zip and RAR archivers
 * (`-p<password>`). Elsewhere `-p` is a port (`ssh`, `psql`, `redis-cli`), a parents flag or a publish.
 */
const PASSWORD_COMMANDS = [
  'mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlcheck', 'mysqlshow', 'mysqlslap', 'mysqlpump', 'mysqlbinlog',
  'mysqlsh', 'mysql_upgrade', 'mysql_secure_installation',
  'mariadb', 'mariadb-dump', 'mariadb-admin', 'mariadb-import', 'mariadb-check', 'mariadb-show', 'mariadb-slap',
  'mariadb-binlog', 'mariadb-upgrade', 'mariadb-secure-installation',
  'mongo', 'mongosh', 'mongodump', 'mongorestore', 'mongoexport', 'mongoimport', 'mongostat', 'mongotop', 'mongofiles',
  'sshpass', 'cqlsh', 'rabbitmqadmin', 'rdesktop', '7z', '7za', '7zr', 'rar', 'unrar',
];

/** A password command, from its word to the end of the command: a newline (unless continued with a
 * backslash, which trailing spaces or tabs may follow), or `;`, `|` or `&` outside quotes. A version
 * after the name (`mysql8`, `mysql5.7`, `mariadb10.11`) counts as the base tool. Longer names come
 * first in the alternation. */
const PASSWORD_COMMAND_WORD = `\\b(?:${[...PASSWORD_COMMANDS].sort((a, b) => b.length - a.length).join('|')})(?:\\d+(?:\\.\\d+)*)?(?![\\w-])`;
const PASSWORD_COMMAND = new RegExp(`${PASSWORD_COMMAND_WORD}(?:"[^"\\n]*"|'[^'\\n]*'|\\\\[ \\t]*\\r?\\n|[^\\n;|&])*`, 'gi');

/** A password command's name anywhere in a text. */
const PASSWORD_COMMAND_NAME = new RegExp(PASSWORD_COMMAND_WORD, 'i');

/** -p value / -p=value / -pvalue, whatever the value's length. */
const PASSWORD_FLAG = /(^|[\s"'`(])(-p)(\s+|=)?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'-][^\s"']*))/g;

/** `-p` values in each password-taking command (see `PASSWORD_COMMAND`). With `accept`, a value is
 * redacted only when `accept` says so, given the value (inside its quotes, if any), the text and the
 * index in it just after the value. */
function redactPasswordFlags(text: string, accept?: (value: string, text: string, after: number) => boolean): string {
  return text.replace(PASSWORD_COMMAND, (command, at: number) =>
    command.replace(PASSWORD_FLAG, (m, lead: string, flag: string, sep: string | undefined, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number) => {
      const s = sep ?? '';
      const value = dq ?? sq ?? bare ?? '';
      if (keep(value)) return m;
      if (accept !== undefined && !accept(value, text, at + offset + m.length)) return m;
      if (dq !== undefined) return `${lead}${flag}${s}"${REDACTED}"`;
      if (sq !== undefined) return `${lead}${flag}${s}'${REDACTED}'`;
      return `${lead}${flag}${s}${REDACTED}`;
    }),
  );
}

/**
 * Authorization headers and the `=` form: any key that ends in `authorization` (`Authorization`,
 * `Proxy-Authorization`, `HTTP_AUTHORIZATION`, `x_authorization`), any casing, with `:` or `=`. The
 * value goes to the end of the line, any scheme, or to the closing quote when the value, or the whole
 * pair, is quoted (`-H "Authorization: Token abc"`). Groups: the pair's opening quote, the name, the
 * separator, then the value: double-quoted, single-quoted, or the rest of the line.
 */
const AUTHORIZATION = `(?:(["'])|(?<![A-Za-z0-9_.-]))([A-Za-z0-9_.-]*authorization)(${H}*[=:]${H}*)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\n]*))`;

function redactAuthorization(m: string, quote?: string, name?: string, sep?: string, dq?: string, sq?: string, rest?: string): string {
  const open = quote ?? '';
  const head = `${open}${name}${sep}`;
  if (dq !== undefined) return keep(dq) ? m : `${head}"${REDACTED}"`;
  if (sq !== undefined) return keep(sq) ? m : `${head}'${REDACTED}'`;
  const close = open === '' ? -1 : (rest ?? '').indexOf(open);
  const value = close === -1 ? (rest ?? '') : (rest ?? '').slice(0, close);
  return keep(value.trim()) ? m : `${head}${REDACTED}${close === -1 ? '' : (rest ?? '').slice(close)}`;
}

/** Whether the line that ends at `eol` (the index of its `\n`, or the text's length) ends in a
 * backslash continuation, as `PASSWORD_COMMAND` reads one: `\`, then spaces or tabs, then CR LF or LF. */
function continues(text: string, eol: number): boolean {
  if (eol >= text.length) return false;
  let i = eol;
  if (text[i - 1] === '\r') i--;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--;
  return text[i - 1] === '\\';
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

const AUTHORIZATION_SCAN = new RegExp(AUTHORIZATION, 'gi');

/** The end of the line (its `\n`, or the text's length) of an authorization value that the
 * authorization rule takes to the end of a line continued with a backslash; or -1 for any other. */
function continuedValueEnd(text: string, m: RegExpExecArray): number {
  const [whole, quote, , , dq, sq, rest] = m;
  if (rest === undefined || dq !== undefined || sq !== undefined || keep(rest.trim())) return -1;
  if (quote !== undefined && rest.includes(quote)) return -1;
  const eol = m.index + whole.length;
  return continues(text, eol) ? eol : -1;
}

/** Stands in for the name of a password command that an authorization value took. */
const PASSWORD_COMMAND_STAND_IN = 'mysql ';

/** A closing quote, then spaces and control characters (which `cleanDetail` drops) up to a line
 * break. Sticky. */
const VALUE_TAIL = /["']?(?:[^\S\n\r\u2028\u2029]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])*/y;

/**
 * Whether `redactContinuedLines` may redact a `-p` value that ends at `after` in `text`: one that is
 * `quiet` with no quote or backslash in it (`-p\"session\"=` is an escaped key), not quoted and glued
 * to more text (`-p'-p'x'`), and, when nothing but
 * spaces (or a quote) follows it on its line, or a separator does, does not end in a word another rule
 * reads with what follows (`-p)cookie :`), also once `cleanSummary` joins the lines (`-ptoken` then
 * `= x`, `-pBearer` then a token). It looks only as far as the next word, so a line of
 * many values is read once.
 */
function freeValue(value: string, text: string, after: number): boolean {
  if (!quiet(value, '"') || /["\\]/.test(value)) return false;
  // A quoted value (its closing quote just before `after`) glued to more text: the quotes pair anew.
  if (/["']/.test(text[after - 1] ?? '') && /[^\s]/.test(text[after] ?? ' ')) return false;
  VALUE_TAIL.lastIndex = after;
  VALUE_TAIL.test(text);
  const next = text[VALUE_TAIL.lastIndex];
  if (next !== undefined && !/[\s"'=:]/.test(next)) return true;
  const word = /[A-Za-z0-9_.-]*$/.exec(value)?.[0] ?? '';
  return !isSecretKey(word) && !/bearer|basic/i.test(word);
}

/** The lines `[from, to)` after an authorization value that a password command runs through (see
 * `continuedCommands`); with `raw`, the rules after the authorization rule leave them alone. */
type ContinuedCommand = { from: number; to: number; raw: boolean };

/**
 * Password commands that run through an authorization value which takes the rest of its line. A
 * command continued onto the next line with a backslash (`Authorization: x; mysql \` then
 * `-p s3cret`, or `mysql -H Authorization: x \` then `-p s3cret`) loses the end of its first line,
 * backslash included, to the authorization rule, so the `-p` rule no longer sees its `-p` on the next
 * lines. For each logical line (lines joined by backslash continuations) that holds such a value, the
 * first one a password command runs through (as `PASSWORD_COMMAND` reads the line as it is) gives the
 * lines after it, to the end of the logical line. Each logical line is looked at once, so the scan
 * stays linear.
 */
function continuedCommands(text: string): ContinuedCommand[] {
  const found: ContinuedCommand[] = [];
  let done = 0;
  AUTHORIZATION_SCAN.lastIndex = 0;
  for (let m = AUTHORIZATION_SCAN.exec(text); m !== null; m = AUTHORIZATION_SCAN.exec(text)) {
    let eol = continuedValueEnd(text, m);
    if (eol === -1) continue;
    // The logical line: back over the lines that continue onto this one, then on to its end.
    let start = text.lastIndexOf('\n', m.index - 1) + 1;
    while (start > done && continues(text, start - 1)) start = Math.max(done, text.lastIndexOf('\n', start - 2) + 1);
    let end = lineEnd(text, eol + 1);
    while (continues(text, end)) end = lineEnd(text, end + 1);
    done = end;
    // The password commands on it, in order, and the first value one of them runs through.
    const commands = [...text.slice(start, end).matchAll(PASSWORD_COMMAND)].map((c) => [start + c.index, start + c.index + c[0].length]);
    let next = 0;
    let through = -1;
    for (let a: RegExpExecArray | null = m; a !== null && a.index < end; a = AUTHORIZATION_SCAN.exec(text)) {
      eol = continuedValueEnd(text, a);
      if (eol === -1) continue;
      while (next < commands.length && (commands[next]?.[1] ?? 0) <= eol) next++;
      if (next < commands.length && (commands[next]?.[0] ?? end) < eol) {
        through = eol;
        break;
      }
    }
    AUTHORIZATION_SCAN.lastIndex = end;
    if (through === -1) continue;
    // Lines the later rules leave alone, as they are and joined, with no quote in them or the line
    // after (which `cleanSummary`, joining the lines, may pair with one on the line above).
    const after = text.slice(through + 1, lineEnd(text, end + 1));
    const untouched = (lines: string): boolean => applyRules(LATER_RULES, lines) === lines;
    found.push({ from: through + 1, to: end, raw: !/["']/.test(after) && untouched(after) && untouched(oneLine(after)) });
  }
  return found;
}

/**
 * `-p` values on the lines of each `raw` continued command, before the authorization rule, whatever
 * they hold: nothing after them reads those lines, as they are or joined.
 */
function redactRawContinued(text: string, found: ContinuedCommand[]): string {
  let out = '';
  let done = 0;
  for (const { from, to, raw } of found) {
    if (!raw) continue;
    out += text.slice(done, from) + redactPasswordFlags(PASSWORD_COMMAND_STAND_IN + text.slice(from, to)).slice(PASSWORD_COMMAND_STAND_IN.length);
    done = to;
  }
  return out + text.slice(done);
}

/**
 * `-p` values on the lines of each other continued command, after every rule has run: `out` is
 * `text` redacted, line for line (no rule after the URL rule adds or removes a line break), so the
 * `-p` rule reads what the other rules made of those lines and only adds markers to it. It reads the
 * values they read first (`-ptoken db` keeps `db` redacted as the `--flag` rule's value, and
 * `-ptoken` then a line holding `x` keeps `x` redacted) and its value may have any shape (`-ptoken`,
 * `-p 'a b'`, `-p "a b"`), but it redacts only a `freeValue`, so that the next pass, or
 * `cleanSummary` joining the lines, still reads what it read before.
 */
function redactContinuedLines(out: string, text: string, found: ContinuedCommand[]): string {
  if (found.every(({ raw }) => raw)) return out;
  const lines = out.split('\n');
  if (lines.length !== text.split('\n').length) return out;
  let line = 0;
  let at = 0;
  for (const { from, to, raw } of found) {
    for (; at < from; at++) if (text[at] === '\n') line++;
    let last = line;
    for (; at < to; at++) if (text[at] === '\n') last++;
    if (!raw && last < lines.length) {
      const redacted = redactPasswordFlags(PASSWORD_COMMAND_STAND_IN + lines.slice(line, last + 1).join('\n'), freeValue);
      const parts = redacted.slice(PASSWORD_COMMAND_STAND_IN.length).split('\n');
      if (parts.length === last - line + 1) for (let i = 0; i < parts.length; i++) lines[line + i] = parts[i] ?? '';
    }
    line = last;
  }
  return lines.join('\n');
}

/** A rule is a pattern and its replacement, or a function over the whole text. */
type Rule = [RegExp, (match: string, ...groups: string[]) => string] | ((text: string) => string);

/** The rules before `continuedCommands` looks at the text. */
const EARLY_RULES: Rule[] = [
  // PEM private keys, to the END line (or the end of the text when cut off).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // user:password@ in URLs. The scheme starts where its run of characters starts (digits, `+`, `.`
  // and `-` that lead the run are kept as they are), so a long word is scanned once.
  [
    /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_m, lead, scheme) => `${lead}${scheme}${REDACTED}@`,
  ],
];

/** The rules after it, in order. No rule here adds or removes a line break (see `redactContinuedLines`). */
const LATER_RULES: Rule[] = [
  // Authorization headers and the `=` form (see `AUTHORIZATION`).
  [new RegExp(AUTHORIZATION, 'gi'), redactAuthorization],
  // Cookie and Set-Cookie headers: every cookie value, whatever its length.
  [/\b((?:Set-)?Cookie)([ \t]*:[ \t]*)([^\n]*)/gi, (_m, name, sep, value) => `${name}${sep}${redactCookies(value, /^set-/i.test(name))}`],
  // Authorization header schemes elsewhere in text.
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme, space) => `${scheme}${space}${REDACTED}`],
  // autologger tokens (MCP access and refresh), and common provider token shapes.
  [/\b(alm|alr)_[A-Za-z0-9_-]{4,}/g, () => REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, () => REDACTED],
  // JWTs.
  // The first part stops before a later `-eyJ`, which is tried as a start of its own, so a long run
  // of `eyJ-eyJ-...` is scanned once rather than once per `eyJ`.
  [/\beyJ(?:[A-Za-z0-9_]|-(?!eyJ)){4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, () => REDACTED],
  // The autologger session cookie, in any form (Cookie header, Set-Cookie, a bare pair).
  [/\b(autologger_sid)(\s*[=:]\s*)("?)([^\s;,"]+)\3/g, (m, name, sep, q, value) => (keep(value) ? m : `${name}${sep}${q}${REDACTED}${q}`)],
  // key=value / key: value / "key": "value" with a secret-looking key.
  redactKeyValues,
  // --token value / --api-key value (the = form is covered above), after any command. The flag is
  // the run of flag characters from its first `-` (letters and digits before that `-` are kept as
  // they are); matching starts only where such a run starts, so a long word is scanned once. The first
  // lookahead finds the secret word in the run, scanning it once; the second takes the whole run as
  // the flag with no way back (a backreference does not backtrack), so a run that holds the word many
  // times (`--token-token-...`) is not retried at each of them.
  [
    /(?<![A-Za-z0-9-])([A-Za-z0-9]*)(?=-[A-Za-z0-9-]*?(?:token|secret|password|passwd|api-key|apikey|cookie))(?=(-[A-Za-z0-9-]*))\2(\s+)(["']?)([^\s"'-][^\s"']*)\4/gi,
    (m, lead, flag, space, q, value) => (keep(value) ? m : `${lead}${flag}${space}${q}${REDACTED}${q}`),
  ],
  // -p value / -p=value / -pvalue, only in mysql and similar commands.
  redactPasswordFlags,
  // Long random-looking strings: base64 with slashes (40+), then token characters (32+).
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (looksRandom(m, true) ? REDACTED : m)],
  [/[A-Za-z0-9_+=-]{32,}/g, (m) => (looksRandom(m, false) ? REDACTED : m)],
  // key=value with escaped quotes (`{\"password\": \"x\"}`), last (see `redactEscapedKeyValues`).
  redactEscapedKeyValues,
];

function applyRules(rules: Rule[], text: string): string {
  let out = text;
  for (const rule of rules) out = typeof rule === 'function' ? rule(out) : out.replace(rule[0], rule[1] as (m: string, ...g: string[]) => string);
  return out;
}

/**
 * One pass of every rule. Between the early and the later rules, the `-p` values of password commands
 * that run through a continued authorization value are redacted: on lines nothing else reads, before
 * the authorization rule takes the command's name (`redactRawContinued`); on the others, after every
 * rule has run (`redactContinuedLines`).
 */
function redactOnce(text: string): string {
  const early = applyRules(EARLY_RULES, text);
  const found = continuedCommands(early);
  return redactContinuedLines(applyRules(LATER_RULES, redactRawContinued(early, found)), early, found);
}

/** Passes `redact` makes at most; real text settles in one or two. */
const MAX_PASSES = 8;

/**
 * Replaces everything that looks like a token or secret with `[redacted]`, pass after pass until a
 * pass changes nothing, so the result is idempotent (`containsSecret(redact(x)) === false`) even when
 * one rule's output feeds another's input.
 */
export function redact(text: string): string {
  let out = text;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = redactOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Whether `text` still holds anything `redact` would change. */
export function containsSecret(text: string): boolean {
  return redactOnce(text) !== text;
}

/**
 * Cuts `text` to at most `max` characters, marking the cut with an ellipsis. The cut never lands
 * inside a `[redacted]` marker (it moves to before the marker), and when `text` itself holds nothing
 * secret-looking, trailing words are dropped until the result holds nothing either, also when quoted:
 * a cut can leave a dangling `token=…`, `Authorization: …` or `"api_key": "…`.
 */
export function cap(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let head = chars.slice(0, max - 1).join('');
  for (let at = text.indexOf(REDACTED); at !== -1 && at < head.length; at = text.indexOf(REDACTED, at + 1)) {
    if (head.length < at + REDACTED.length) head = text.slice(0, at);
  }
  if (!containsSecret(text)) {
    const dangling = (h: string): boolean => containsSecret(`${h}…`) || containsSecret(`"${h}…"`);
    while (head !== '' && dangling(head)) head = head.replace(/\s*\S*\s*$/, '');
  }
  return `${head}…`;
}

/** One line: control characters and runs of whitespace become single spaces. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
}

/** Keeps newlines and tabs, drops other control characters, trims trailing whitespace. */
function cleanMultiline(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd();
}

/**
 * The stored summary: redacted, made one line, redacted again and capped. Redacting before the cap
 * means a cut can't expose part of a secret; redacting again after joining lines means the stored
 * value is clean on its own (`containsSecret` is false), which `file` relies on.
 */
export function cleanSummary(text: string): string {
  return cap(redact(oneLine(redact(text))), SUMMARY_MAX);
}

export function cleanDetail(text: string): string {
  return cap(redact(cleanMultiline(redact(text))), DETAIL_MAX);
}

/**
 * A summary reduced to what identifies the issue: lower-cased, with URLs, emails, paths, UUIDs, hex,
 * ids and numbers masked, so the same issue worded with different values gives the same text.
 */
export function normalise(summary: string): string {
  return redact(summary)
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/g, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '<email>')
    .replace(/(^|[\s'"=(:,[])((~|\.{1,2})?\/[^\s'"(),\]]*|[a-z]:\\[^\s'"(),]*)/g, '$1<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b(0x)?[0-9a-f]*\d[0-9a-f]*[a-f][0-9a-f]*\b|\b(0x)?[0-9a-f]*[a-f][0-9a-f]*\d[0-9a-f]*\b/g, (m) => (m.length >= 6 ? '<hex>' : m))
    .replace(/\b(?=[a-z_-]*\d)(?=[0-9_-]*[a-z])[a-z0-9_-]{5,}\b/g, '<id>')
    .replace(/\d+([.:]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .replace(/[\s.!;,]+$/, '')
    .trim();
}

/** The stable id of an issue: (plugin, kind, normalised summary), hashed. */
export function signature(plugin: string, kind: string, summary: string): string {
  return createHash('sha256').update(`${plugin}\n${kind}\n${normalise(summary)}`).digest('hex').slice(0, 12);
}
