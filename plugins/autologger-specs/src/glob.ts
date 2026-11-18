// A port of autologger's git-style glob matcher (`glob_re` / `matches` in scripts/lib/check_change.py):
// `**/` spans directories (including none), `**` matches anything, `*` and `?` stay within one path
// segment, everything else is literal, and the match is anchored at both ends.
//
// Python's `.` does not match a newline; JavaScript's also skips \r, U+2028 and U+2029, so `[^\n]` is
// used instead. The `u` flag makes `?` and `[^/]` consume one code point, as Python's `re` does.

const cache = new Map<string, RegExp>();

export function globSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:[^\\n]*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out += '[^\\n]*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += (pattern[i] ?? '').replace(/[\\^$.*+?()[\]{}|/]/, '\\$&');
      i += 1;
    }
  }
  return `^(?:${out})$`;
}

export function globRe(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(globSource(pattern), 'u');
    cache.set(pattern, re);
  }
  return re;
}

export function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globRe(p).test(path));
}

/** Sorts like Python's sorted() on str: by code point, not UTF-16 unit. */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
