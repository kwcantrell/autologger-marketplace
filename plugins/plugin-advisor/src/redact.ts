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
/** A quoted value whose quotes are escaped (`\"abc\"`), tried before `KEY_VALUE`. It counts only when
 * the closing quote has the same escape as the opening one; otherwise the value is read by `KEY_VALUE`
 * as before (`\"session"=x` is a backslash and then the key `"session"`). */
const ESCAPED_VALUE = /([bBuUrR]{0,2})(\\+)(?:"([^"\n]*)"|'([^'\n]*)')/y;

/** The escaped quoted value at `at`, redacted, with its length; or undefined when there is none. */
function escapedValue(text: string, at: number): [string, number] | undefined {
  ESCAPED_VALUE.lastIndex = at;
  const v = ESCAPED_VALUE.exec(text);
  if (v === null) return undefined;
  const [value, prefix = '', escape = '', dq, sq] = v;
  const quote = dq === undefined ? "'" : '"';
  const inner = dq ?? sq ?? '';
  if (!inner.endsWith(escape)) return undefined;
  const content = inner.slice(0, inner.length - escape.length);
  return [keep(content) ? value : `${prefix}${escape}${quote}${REDACTED}${escape}${quote}`, value.length];
}

/**
 * `key=value`, `key: value` and `"key": "value"` with a secret-looking key: the value is redacted;
 * only an exact marker is kept, so `[redacted]x` is redacted again. One scan, left to right: after an
 * ordinary key the scan goes on inside its value, so `failed: password=x` and `error=token=abc` are
 * redacted, with no recursion and in linear time however many `a=a=...` segments a line holds.
 * `keySep` is `KEY_SEP` or `ESCAPED_KEY_SEP`; its groups are the key's opening quote, the key and the
 * separator. With `quotedOnly`, a value that is not quoted is left alone.
 */
function scanKeyValues(text: string, keySep: RegExp, quotedOnly: boolean): string {
  let out = '';
  let done = 0;
  keySep.lastIndex = 0;
  for (let m = keySep.exec(text); m !== null; m = keySep.exec(text)) {
    const [head, q, key = '', sep = ''] = m;
    if (!isSecretKey(key)) continue;
    const at = m.index + head.length;
    // A `Cookie:` header on its line is the cookie rule's (above): its value is `name=[redacted]`.
    const cookieHeader = q === undefined && /^(set-)?cookie$/i.test(key) && /^[ \t]*:[ \t]*$/.test(sep);
    let replaced: string;
    let end: number;
    const escaped = escapedValue(text, at);
    if (escaped !== undefined) {
      end = at + escaped[1];
      keySep.lastIndex = end;
      if (cookieHeader) continue;
      replaced = escaped[0];
    } else {
      KEY_VALUE.lastIndex = at;
      const v = KEY_VALUE.exec(text);
      if (v === null) continue;
      const [value, prefix = '', dq, sq, bare] = v;
      end = at + value.length;
      keySep.lastIndex = end;
      if (cookieHeader) continue;
      if (dq !== undefined) replaced = keep(dq) ? value : `${prefix}"${REDACTED}"`;
      else if (sq !== undefined) replaced = keep(sq) ? value : `${prefix}'${REDACTED}'`;
      else if (quotedOnly) continue;
      else replaced = keep(bare ?? '') ? value : REDACTED;
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
 * is a key whose value is on the next line until `cleanSummary` joins the lines.
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
const PASSWORD_COMMAND = new RegExp(
  `\\b(?:${[...PASSWORD_COMMANDS].sort((a, b) => b.length - a.length).join('|')})(?:\\d+(?:\\.\\d+)*)?(?![\\w-])` +
    `(?:"[^"\\n]*"|'[^'\\n]*'|\\\\[ \\t]*\\r?\\n|[^\\n;|&])*`,
  'gi',
);

/** -p value / -p=value / -pvalue, whatever the value's length. */
const PASSWORD_FLAG = /(^|[\s"'`(])(-p)(\s+|=)?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'-][^\s"']*))/g;

/** `-p` values in each password-taking command (see `PASSWORD_COMMAND`). */
function redactPasswordFlags(text: string): string {
  return text.replace(PASSWORD_COMMAND, (command) =>
    command.replace(PASSWORD_FLAG, (m, lead: string, flag: string, sep: string | undefined, dq?: string, sq?: string, bare?: string) => {
      const s = sep ?? '';
      if (dq !== undefined) return keep(dq) ? m : `${lead}${flag}${s}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${lead}${flag}${s}'${REDACTED}'`;
      return keep(bare ?? '') ? m : `${lead}${flag}${s}${REDACTED}`;
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

/**
 * `-p` values in a password command that an authorization value takes to the end of its line, run
 * before the authorization rule. A command continued onto the next line with a backslash
 * (`Authorization: Token abc; mysql \` then `-p s3cret`) would otherwise lose its first line, and with
 * it its name, so its `-p` on the next line would be kept. Only the logical line from the value on is
 * done here. The command is left for `redactPasswordFlags` in its usual place, as before, when the
 * continuation lines and the line after them hold a quote (which `cleanSummary`, joining the lines,
 * may pair with one on the line above), or when the rules after this one change anything in them,
 * as they are or joined onto one line: a `-p` value that is itself a key or a flag (`-ptoken x`), or
 * that holds another command's name, is then read the way it was before. Each logical line is looked
 * at once, so the scan stays linear.
 */
function redactPasswordFlagsFirst(text: string): string {
  let out = '';
  let done = 0;
  AUTHORIZATION_SCAN.lastIndex = 0;
  for (let m = AUTHORIZATION_SCAN.exec(text); m !== null; m = AUTHORIZATION_SCAN.exec(text)) {
    const [whole, quote, , , dq, sq, rest] = m;
    const eol = m.index + whole.length;
    // Only a value the authorization rule takes to the end of the line, and only a continued line.
    if (rest === undefined || dq !== undefined || sq !== undefined || keep(rest.trim())) continue;
    if ((quote !== undefined && rest.includes(quote)) || !continues(text, eol)) continue;
    let end = lineEnd(text, eol + 1);
    while (continues(text, end)) end = lineEnd(text, end + 1);
    AUTHORIZATION_SCAN.lastIndex = end;
    const after = text.slice(eol + 1, lineEnd(text, end + 1));
    const untouched = (lines: string): boolean => applyRules(LATER_RULES, lines) === lines;
    if (/["']/.test(after) || !untouched(after) || !untouched(oneLine(after))) continue;
    const start = eol - rest.length;
    out += text.slice(done, start) + redactPasswordFlags(text.slice(start, end));
    done = end;
  }
  return out + text.slice(done);
}

/** A rule is a pattern and its replacement, or a function over the whole text. */
type Rule = [RegExp, (match: string, ...groups: string[]) => string] | ((text: string) => string);

const RULES: Rule[] = [
  // PEM private keys, to the END line (or the end of the text when cut off).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // user:password@ in URLs. The scheme starts where its run of characters starts (digits, `+`, `.`
  // and `-` that lead the run are kept as they are), so a long word is scanned once.
  [
    /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_m, lead, scheme) => `${lead}${scheme}${REDACTED}@`,
  ],
  // -p values in a password command inside an authorization value continued onto the next line.
  redactPasswordFlagsFirst,
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

/** The rules after `redactPasswordFlagsFirst`. */
const LATER_RULES = RULES.slice(RULES.indexOf(redactPasswordFlagsFirst) + 1);

function applyRules(rules: Rule[], text: string): string {
  let out = text;
  for (const rule of rules) out = typeof rule === 'function' ? rule(out) : out.replace(rule[0], rule[1] as (m: string, ...g: string[]) => string);
  return out;
}

function redactOnce(text: string): string {
  return applyRules(RULES, text);
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
