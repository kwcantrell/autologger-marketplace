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

/** A `key=value` / `key: value` key and its separator. Matching stops here, so a value is scanned too. */
const KEY_SEP = /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[=:]\s*)/g;
/** The value after a key: quoted, or a bare run of value characters, where a `]` ends it unless it
 * closes a marker or more value follows. Sticky: it is tried only right after a key's separator. */
const KEY_VALUE = /"([^"\n]*)"|'([^'\n]*)'|((?:\[redacted\]|\](?=[^\s"'&;,)}\]])|[^\s"'&;,)}\]])+)/y;

/**
 * `key=value`, `key: value` and `"key": "value"` with a secret-looking key: the value is redacted;
 * only an exact marker is kept, so `[redacted]x` is redacted again. One scan, left to right: after an
 * ordinary key the scan goes on inside its value, so `failed: password=x` and `error=token=abc` are
 * redacted, with no recursion and in linear time however many `a=a=...` segments a line holds.
 */
function redactKeyValues(text: string): string {
  let out = '';
  let done = 0;
  KEY_SEP.lastIndex = 0;
  for (let m = KEY_SEP.exec(text); m !== null; m = KEY_SEP.exec(text)) {
    const [head, q = '', key = '', sep = ''] = m;
    if (!isSecretKey(key)) continue;
    const at = m.index + head.length;
    KEY_VALUE.lastIndex = at;
    const v = KEY_VALUE.exec(text);
    if (v === null) continue;
    const [value, dq, sq, bare] = v;
    const end = at + value.length;
    KEY_SEP.lastIndex = end;
    // A `Cookie:` header on its line is the cookie rule's (above): its value is `name=[redacted]`.
    if (q === '' && /^(set-)?cookie$/i.test(key) && /^[ \t]*:[ \t]*$/.test(sep)) continue;
    let replaced: string;
    if (dq !== undefined) replaced = keep(dq) ? value : `"${REDACTED}"`;
    else if (sq !== undefined) replaced = keep(sq) ? value : `'${REDACTED}'`;
    else replaced = keep(bare ?? '') ? value : REDACTED;
    out += text.slice(done, at) + replaced;
    done = end;
  }
  return out + text.slice(done);
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
 * backslash), or `;`, `|` or `&` outside quotes. Longer names come first in the alternation. */
const PASSWORD_COMMAND = new RegExp(
  `\\b(?:${[...PASSWORD_COMMANDS].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])(?:"[^"\\n]*"|'[^'\\n]*'|\\\\\\r?\\n|[^\\n;|&])*`,
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

/** A rule is a pattern and its replacement, or a function over the whole text. */
type Rule = [RegExp, (match: string, ...groups: string[]) => string] | ((text: string) => string);

const RULES: Rule[] = [
  // PEM private keys, to the END line (or the end of the text when cut off).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`],
  // Authorization and Proxy-Authorization headers: the whole value to the end of the line, any scheme.
  [
    /\b((?:Proxy-)?Authorization)([ \t]*:[ \t]*)([^\n]*)/gi,
    (m, name, sep, value) => (value.trim() === '' || value.trim() === REDACTED ? m : `${name}${sep}${REDACTED}`),
  ],
  // The `=` form (`authorization=Token abc`, `HTTP_AUTHORIZATION=...`), any casing: to the end of the
  // line as for the header, or to the closing quote when the value, or the whole pair, is quoted.
  [
    /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]*authorization)([ \t]*=[ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\n]*))/gi,
    (m, open, name, sep, dq, sq, rest) => {
      const head = `${open}${name}${sep}`;
      if (dq !== undefined) return keep(dq) ? m : `${head}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${head}'${REDACTED}'`;
      const close = open === '' ? -1 : (rest ?? '').indexOf(open);
      const value = close === -1 ? (rest ?? '') : (rest ?? '').slice(0, close);
      return keep(value.trim()) ? m : `${head}${REDACTED}${close === -1 ? '' : (rest ?? '').slice(close)}`;
    },
  ],
  // Cookie and Set-Cookie headers: every cookie value, whatever its length.
  [/\b((?:Set-)?Cookie)([ \t]*:[ \t]*)([^\n]*)/gi, (_m, name, sep, value) => `${name}${sep}${redactCookies(value, /^set-/i.test(name))}`],
  // Authorization header schemes elsewhere in text.
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme, space) => `${scheme}${space}${REDACTED}`],
  // autologger tokens (MCP access and refresh), and common provider token shapes.
  [/\b(alm|alr)_[A-Za-z0-9_-]{4,}/g, () => REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, () => REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, () => REDACTED],
  // The autologger session cookie, in any form (Cookie header, Set-Cookie, a bare pair).
  [/\b(autologger_sid)(\s*[=:]\s*)("?)([^\s;,"]+)\3/g, (m, name, sep, q, value) => (keep(value) ? m : `${name}${sep}${q}${REDACTED}${q}`)],
  // key=value / key: value / "key": "value" with a secret-looking key.
  redactKeyValues,
  // --token value / --api-key value (the = form is covered above), after any command.
  [
    /(--?[A-Za-z0-9-]*(?:token|secret|password|passwd|api-key|apikey|cookie)[A-Za-z0-9-]*)(\s+)(["']?)([^\s"'-][^\s"']*)\3/gi,
    (m, flag, space, q, value) => (keep(value) ? m : `${flag}${space}${q}${REDACTED}${q}`),
  ],
  // -p value / -p=value / -pvalue, only in mysql and similar commands.
  redactPasswordFlags,
  // Long random-looking strings: base64 with slashes (40+), then token characters (32+).
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (looksRandom(m, true) ? REDACTED : m)],
  [/[A-Za-z0-9_+=-]{32,}/g, (m) => (looksRandom(m, false) ? REDACTED : m)],
];

function redactOnce(text: string): string {
  let out = text;
  for (const rule of RULES) out = typeof rule === 'function' ? rule(out) : out.replace(rule[0], rule[1] as (m: string, ...g: string[]) => string);
  return out;
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
