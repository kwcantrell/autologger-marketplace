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

/** Values left alone: empty, or already (partly) redacted, so a second pass changes nothing. */
function keep(value: string): boolean {
  return value === '' || value.includes('[redacted');
}

/** A long run of token characters that looks random (mixes letters and digits) rather than a word. */
function looksRandom(text: string, needsCaseMix: boolean): boolean {
  const digit = /\d/.test(text);
  const lower = /[a-z]/.test(text);
  const upper = /[A-Z]/.test(text);
  return needsCaseMix ? digit && lower && upper : digit && (lower || upper);
}

/** A Cookie or Set-Cookie header value with every cookie's value redacted, attributes kept. */
function redactCookies(value: string): string {
  return value
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      if (COOKIE_ATTRIBUTE.test(name)) return part;
      if (eq === -1) return name === '' || keep(name) ? part : part.replace(name, REDACTED);
      const raw = part.slice(eq + 1);
      const v = raw.trim();
      return v === '' || v === REDACTED || v === `"${REDACTED}"` ? part : `${part.slice(0, eq + 1)}${raw.match(/^\s*/)?.[0] ?? ''}${REDACTED}`;
    })
    .join(';');
}

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

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
  // Cookie and Set-Cookie headers: every cookie value, whatever its length.
  [/\b((?:Set-)?Cookie)([ \t]*:[ \t]*)([^\n]*)/gi, (_m, name, sep, value) => `${name}${sep}${redactCookies(value)}`],
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
  [
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[=:]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'&;,)}\]]+))/g,
    (m, q, key, sep, dq, sq, bare) => {
      if (!isSecretKey(key ?? '')) return m;
      if (dq !== undefined) return keep(dq) ? m : `${q}${key}${q}${sep}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${q}${key}${q}${sep}'${REDACTED}'`;
      return keep(bare ?? '') ? m : `${q}${key}${q}${sep}${REDACTED}`;
    },
  ],
  // --token value / --api-key value (the = form is covered above).
  [
    /(--?[A-Za-z0-9-]*(?:token|secret|password|passwd|api-key|apikey|cookie)[A-Za-z0-9-]*)(\s+)(["']?)([^\s"'-][^\s"']*)\3/gi,
    (m, flag, space, q, value) => (keep(value) ? m : `${flag}${space}${q}${REDACTED}${q}`),
  ],
  // -p value / -p=value / -pvalue (a password flag for mysql and others), whatever the value's length.
  [
    /(^|[\s"'`(])(-p)(\s+|=)?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'-][^\s"']*))/g,
    (m, lead, flag, sep = '', dq, sq, bare) => {
      if (dq !== undefined) return keep(dq) ? m : `${lead}${flag}${sep}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${lead}${flag}${sep}'${REDACTED}'`;
      return keep(bare ?? '') ? m : `${lead}${flag}${sep}${REDACTED}`;
    },
  ],
  // Long random-looking strings: base64 with slashes (40+), then token characters (32+).
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (looksRandom(m, true) ? REDACTED : m)],
  [/[A-Za-z0-9_+=-]{32,}/g, (m) => (looksRandom(m, false) ? REDACTED : m)],
];

/** Replaces everything that looks like a token or secret with `[redacted]`. Idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replace] of RULES) out = out.replace(re, replace as (m: string, ...g: string[]) => string);
  return out;
}

/** Whether `text` still holds anything `redact` would change. */
export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}

/**
 * Cuts `text` to at most `max` characters, marking the cut with an ellipsis. The cut never lands
 * inside a `[redacted]` marker (it moves to before the marker), and when `text` itself holds nothing
 * secret-looking, trailing words are dropped until the result holds nothing either: a cut can leave
 * `token=…` or `Authorization: …`, which `redact` would rewrite, and `file` would then refuse the draft.
 */
export function cap(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let head = chars.slice(0, max - 1).join('');
  for (let at = text.indexOf(REDACTED); at !== -1 && at < head.length; at = text.indexOf(REDACTED, at + 1)) {
    if (head.length < at + REDACTED.length) head = text.slice(0, at);
  }
  if (!containsSecret(text)) {
    while (head !== '' && containsSecret(`${head}…`)) head = head.replace(/\s*\S*\s*$/, '');
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

/** The stored summary: redacted, then made one line and capped (in that order, so a cut can't expose part of a secret). */
export function cleanSummary(text: string): string {
  return cap(oneLine(redact(text)), SUMMARY_MAX);
}

export function cleanDetail(text: string): string {
  return cap(cleanMultiline(redact(text)), DETAIL_MAX);
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
