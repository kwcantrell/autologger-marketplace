// match: ranks the catalog against a short task description. Local and deterministic: the same
// catalog and text always give the same result. It is a shortlist for Claude, which reads the
// descriptions and decides; the score only orders and filters.
//
// Scoring, per entry (an installed plugin with its skills, a user skill, or an available plugin):
//   - The task and the entry's text (name, description, skill names and descriptions) are split into
//     terms: lowercase words, split on anything but letters and digits (so `list_events` is `list` +
//     `events`), stop words and generic words dropped, then lightly stemmed (`events` -> `event`).
//   - Each distinct task term found in the entry scores 1, or AUTOLOGGER_WEIGHT for an
//     autologger-specific term; the score doubles when the term is in the plugin or skill name.
//   - Each two-word phrase of the task (adjacent kept terms) also found adjacent in the entry adds
//     PHRASE_BONUS.
//   - An entry is a match when its score is at least THRESHOLD: one autologger-specific term plus any
//     other term, or a phrase, or three plain terms. Below that, `none_applicable` is true.
import { DEFAULT_MODE, type Mode } from './config.ts';
import { type Catalog, SELF, type Skill } from './catalog.ts';

export const THRESHOLD = 3;
export const AUTOLOGGER_WEIGHT = 2;
export const NAME_FACTOR = 2;
export const PHRASE_BONUS = 2;
/** Entries kept per list. */
export const LIMIT = 5;
export const ADVISOR = 'plugin-advisor';
/** Longest task text kept in the plugin-advisor summary. */
export const SUMMARY_MAX = 120;

/** Common English words, plus words every entry here shares ("autologger", "plugin", "claude"). */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about after all also an and any are as at be been before but by can could do does doing done for from get got ' +
    'has have help how i if in into is it its just let like make me more my need needs no not now of on once one or our ' +
    'out over please run see set should so some such than that the their them then there these they this those to too ' +
    'up us use used uses using via want was way we what when where which while who why will with would you your ' +
    'autologger plugin plugins skill skills claude code cli command commands tool tools typescript npx ' +
    'task work working thing things something new user users'
  ).split(' '),
);

/** Terms specific to autologger and its tooling (stemmed), weighted AUTOLOGGER_WEIGHT. */
export const AUTOLOGGER_TERMS: ReadonlySet<string> = new Set(
  (
    'mcp session event transcript paragraph topic wiki dashboard studio show aggregate oauth token login ' +
    'spec specs lifecycle gate stale lint openbao bao dev stack https tls ca cert certificate localhost ' +
    'docker makefile chromium browser marketplace scaffold convention friction advisor ' +
    'recurring workaround verify'
  )
    .split(' ')
    .map(stem),
);

/** A light, deterministic suffix stripper: enough that `events`/`event` and `logged`/`log` meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else return w;
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/** The kept terms of a text, in order (stop words dropped, so phrases are pairs of kept terms). */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

function pairs(list: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < list.length; i++) out.add(`${list[i]} ${list[i + 1]}`);
  return out;
}

export interface Score {
  score: number;
  /** The task's terms and phrases found in the entry, in the task's order. */
  matched: string[];
}

/** Scores one entry's name and text against the task's terms. */
export function score(task: readonly string[], name: string, text: string): Score {
  const nameTerms = new Set(terms(name.replace(/-/g, ' ')));
  const textTerms = terms(`${name.replace(/-/g, ' ')} ${text}`);
  const have = new Set(textTerms);
  const havePairs = pairs(textTerms);
  let total = 0;
  const matched: string[] = [];
  for (const t of new Set(task)) {
    if (!have.has(t)) continue;
    total += (AUTOLOGGER_TERMS.has(t) ? AUTOLOGGER_WEIGHT : 1) * (nameTerms.has(t) ? NAME_FACTOR : 1);
    matched.push(t);
  }
  for (const p of pairs(task)) {
    if (!havePairs.has(p)) continue;
    total += PHRASE_BONUS;
    matched.push(`"${p}"`);
  }
  return { score: total, matched };
}

export interface InstalledMatch {
  kind: 'plugin' | 'user-skill';
  /** The plugin's name, or the user skill's name. */
  name: string;
  /** `<plugin>@<marketplace>`; absent for a user skill. */
  id?: string;
  /** The skill that fits best, when the entry has skills. */
  skill?: string;
  description: string;
  enabled: boolean;
  score: number;
  reason: string[];
}

export interface AvailableMatch {
  name: string;
  skill?: string;
  description: string;
  score: number;
  reason: string[];
  installCommand: string;
}

/** A fitting plugin installed only for another project (project or local scope). */
export interface ElsewhereMatch {
  name: string;
  id: string;
  skill?: string;
  description: string;
  scope: string;
  projectPath: string;
  score: number;
  reason: string[];
}

export interface Advisor {
  record: string;
  suggest: string;
}

export interface MatchResult {
  task: string;
  threshold: number;
  /** The plugin-discover mode; with `off`, `available` and `elsewhere` are always empty. */
  mode: Mode;
  installed: InstalledMatch[];
  available: AvailableMatch[];
  /** Fitting plugins installed only for another project: installed elsewhere, not missing. */
  elsewhere: ElsewhereMatch[];
  /**
   * True when no installed, marketplace or installed-elsewhere plugin fits. Decided before mode `off`
   * empties `available` and `elsewhere`, so it stays false when a marketplace plugin fits.
   */
  none_applicable: boolean;
  /** Set when none_applicable and plugin-advisor is installed and enabled. */
  advisor?: Advisor;
}

/** Best skill of an entry, by its own name and description; ties keep the first (sorted) skill. */
function bestSkill(task: readonly string[], skills: readonly Skill[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const s of skills) {
    const { score: v } = score(task, s.name, s.description);
    if (best === undefined || v > best.score) best = { name: s.name, score: v };
  }
  return best === undefined || best.score === 0 ? skills[0]?.name : best.name;
}

function pluginText(p: { description: string; skills: readonly Skill[] }): string {
  // The plugin's description, then each skill's name (as words) and description.
  return [p.description, ...p.skills.map((s) => `${s.name.replace(/-/g, ' ')} ${s.description}`)].join(' ');
}

/** POSIX shell single-quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Characters that are special inside a shell double-quoted string (plus `!`, history expansion). */
const DOUBLE_QUOTE_SPECIAL = /["$`\\!\n]/;

/**
 * The `--package` argument for plugin-advisor. plugin-advisor's skill pre-approves its commands as
 * `--package="${CLAUDE_PLUGIN_ROOT}"`, so the path goes in double quotes, the same form, and the
 * printed line matches that rule without a permission prompt. A path that double quotes cannot hold
 * literally falls back to single quotes: safe, but then Claude Code asks first.
 */
export function packageArg(installPath: string): string {
  return DOUBLE_QUOTE_SPECIAL.test(installPath) ? `--package=${shellQuote(installPath)}` : `--package="${installPath}"`;
}

export function advisorCommands(installPath: string, task: string): Advisor {
  const prefix = `npx --yes --offline --loglevel=error ${packageArg(installPath)} -- ${ADVISOR}`;
  const oneLine = task.replace(/\s+/g, ' ').trim();
  const text = oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 3)}...` : oneLine;
  const summary = `no installed or marketplace plugin fits: ${text}`;
  return {
    record: `${prefix} record --plugin none --kind missing-guidance --summary ${shellQuote(summary)} --json`,
    suggest: `${prefix} suggest --json`,
  };
}

const byScore = <T extends { score: number; name: string }>(a: T, b: T): number => b.score - a.score || a.name.localeCompare(b.name);

export function match(catalog: Catalog, task: string, mode: Mode = DEFAULT_MODE, threshold: number = THRESHOLD): MatchResult {
  const words = terms(task);
  // plugin-discover (SELF) and plugin-advisor (ADVISOR, the "nothing fits" fallback) are never task matches.
  const excluded = (name: string): boolean => name === SELF || name === ADVISOR;
  /** Scores a plugin; undefined when it is excluded or below the threshold. */
  const rank = (p: { name: string; description: string; skills: readonly Skill[] }): { s: Score; skill?: string } | undefined => {
    if (excluded(p.name)) return undefined;
    const s = score(words, p.name, pluginText(p));
    if (s.score < threshold) return undefined;
    const skill = bestSkill(words, p.skills);
    return { s, ...(skill === undefined ? {} : { skill }) };
  };
  const installed: InstalledMatch[] = [];
  for (const p of catalog.installed) {
    const r = rank(p);
    if (r === undefined) continue;
    installed.push({ kind: 'plugin', name: p.name, id: p.id, ...(r.skill === undefined ? {} : { skill: r.skill }), description: p.description, enabled: p.enabled, score: r.s.score, reason: r.s.matched });
  }
  for (const u of catalog.userSkills) {
    const s = score(words, u.name, u.description);
    if (s.score >= threshold) installed.push({ kind: 'user-skill', name: u.name, skill: u.name, description: u.description, enabled: true, score: s.score, reason: s.matched });
  }
  const available: AvailableMatch[] = [];
  for (const p of catalog.available) {
    const r = rank(p);
    if (r === undefined) continue;
    available.push({ name: p.name, ...(r.skill === undefined ? {} : { skill: r.skill }), description: p.description, score: r.s.score, reason: r.s.matched, installCommand: p.installCommand });
  }
  const elsewhere: ElsewhereMatch[] = [];
  for (const p of catalog.installedElsewhere) {
    const r = rank(p);
    if (r === undefined) continue;
    elsewhere.push({ name: p.name, id: p.id, ...(r.skill === undefined ? {} : { skill: r.skill }), description: p.description, scope: p.scope, projectPath: p.projectPath, score: r.s.score, reason: r.s.matched });
  }
  installed.sort(byScore);
  available.sort(byScore);
  elsewhere.sort(byScore);
  // Decided on every fitting plugin, before mode off hides the ones not installed here: "nothing
  // fits" (and the plugin-advisor record line that says so) must not be claimed when one does.
  const noneApplicable = installed.length === 0 && available.length === 0 && elsewhere.length === 0;
  // Mode off: never suggest a plugin that is not installed here.
  const suggest = mode !== 'off';
  const result: MatchResult = {
    task,
    threshold,
    mode,
    installed: installed.slice(0, LIMIT),
    available: suggest ? available.slice(0, LIMIT) : [],
    elsewhere: suggest ? elsewhere.slice(0, LIMIT) : [],
    none_applicable: noneApplicable,
  };
  if (result.none_applicable) {
    const advisor = catalog.installed.find((p) => p.name === ADVISOR && p.enabled);
    if (advisor !== undefined) result.advisor = advisorCommands(advisor.installPath, task);
  }
  return result;
}
