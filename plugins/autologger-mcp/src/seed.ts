// import --create: recreates a whole-account snapshot's structure on a local dev stack, then fills
// it. The MCP write tools cannot make teams, shows or sessions, or transcript words, so those go
// through the local app's HTTP API (appApi.ts, signed in with a `make dev-login` cookie):
//
// - each source studio becomes a team (`POST /api/teams`; its id a slug of the studio id; a team
//   with that id you already belong to is reused; a taken id gets a -2..-5 suffix; the owned-team
//   cap of 20 is reported, not fatal);
// - each show is created in it (`POST /api/shows`) and given the source show's categories (names,
//   kinds, colours, options) with `PUT /api/profile` `show_updates`, so `create_event` by category
//   name resolves;
// - each session is created in its show (`POST /api/sessions`, after `PUT /api/profile` makes its
//   team the active one, as the app creates sessions in the active team) at the source frame rate,
//   with its title;
// - transcript words are added one by one (`POST /api/sessions/:id/transcript-words`), in order;
// - session dashboards are saved with the MCP `save_dashboard` tool.
//
// Events, topics and wiki pages then go through the existing import (importer.ts). What was made
// is kept by source id in the state file's `structure`, saved after every write, so a rerun makes
// nothing twice.
import { type AppClient, detailOf } from './appApi.ts';
import { type Caller, callWithRetry, inputShape, type Rec, type Snapshot, type SnapshotSession, type SnapshotShow, type SnapshotStudio, type Structure, type TargetState } from './copy.ts';
import { CliError } from './errors.ts';
import { clip, isObject } from './http.ts';
import type { TargetSession } from './importer.ts';
import { resultText, type Tool } from './mcp.ts';
import { validRate } from './timecode.ts';

export const DASHBOARD_TOOL = 'save_dashboard';

/** What `import --create` does not copy, and why; in the plan and the README. */
export const NOT_COPIED = [
  'audio and video: never downloaded, uploaded or imported (the media links and offsets list_session_media answered stay in the snapshot only)',
  'transcript paragraphs: autologger stores them only from its own transcript generation runs, and neither its MCP tools nor its HTTP API can write one; the copied words let the target generate them again',
  "a session's start offset, episode and notes: the MCP read tools do not answer them, so sessions are created with offset 0 and no episode or notes (the title is kept)",
  'hidden and archived flags: sessions are created visible and active',
  'studio dashboard templates, team members, invites and show grants, OAuth apps, provider keys and AI chat history',
];

export type StructureKind = 'team' | 'show' | 'categories' | 'session' | 'transcript_words' | 'dashboard';

export interface StructureFailure {
  kind: StructureKind;
  source_id: string;
  reason: string;
}

export interface CreateResult {
  teams_created: number;
  teams_reused: number;
  shows_created: number;
  categories_set: number;
  sessions_created: number;
  transcript_words_copied: number;
  dashboards_saved: number;
  failed: StructureFailure[];
}

export function emptyCreateResult(): CreateResult {
  return { teams_created: 0, teams_reused: 0, shows_created: 0, categories_set: 0, sessions_created: 0, transcript_words_copied: 0, dashboards_saved: 0, failed: [] };
}

export function structureOf(state: TargetState): Structure {
  state.structure ??= { teams: {}, shows: {}, sessions: {}, words: {}, dashboards: {} };
  return state.structure;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether two server origins are the same server (localhost, 127.0.0.1 and [::1] are one host). */
export function sameServer(a: string, b: string): boolean {
  const canon = (raw: string): string => {
    try {
      const url = new URL(raw);
      const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
      return `${url.protocol}//${LOOPBACK.has(url.hostname) ? 'loopback' : url.hostname}:${port}`;
    } catch {
      return raw;
    }
  };
  return canon(a) === canon(b);
}

/** A team id the app accepts (`^[a-z][a-z0-9-]{1,62}$`) for a source studio id. */
export function teamSlug(studioId: string): string {
  let slug = studioId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(slug)) slug = `t-${slug}`.replace(/-+$/, '');
  if (slug.length < 2) slug = `${slug}-team`;
  return slug.slice(0, 63).replace(/-+$/, '');
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** The source show's categories as `PUT /api/profile` `show_updates[].categories` takes them. */
export function categoriesBody(categories: Rec | undefined): Rec[] {
  const items = Array.isArray(categories?.items) ? categories.items.filter(isObject) : [];
  return items.flatMap((c) => {
    const name = str(c.name);
    if (name === undefined) return [];
    const out: Rec = { name, type: str(c.kind) ?? 'BUTTON' };
    if (typeof c.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.color)) out.color = c.color;
    if (Array.isArray(c.dropdown_options)) out.dropdown_options = c.dropdown_options;
    if (typeof c.on_label === 'string') out.on_label = c.on_label;
    if (typeof c.off_label === 'string') out.off_label = c.off_label;
    return [out];
  });
}

/** A session's frame rate on the source, as `POST /api/sessions` takes it (1 to 120). */
export function sourceFps(s: SnapshotSession): number | undefined {
  const fps = s.session.fps;
  return validRate(fps) && fps >= 1 && fps <= 120 ? fps : undefined;
}

/** The `POST /api/sessions` body for a source session in a target show. */
export function newSessionBody(s: SnapshotSession, targetShowId: string): Rec {
  const title = (str(s.session.title) ?? str(s.listed?.title) ?? s.session_id).trim().slice(0, 200);
  const body: Rec = { title, frame_rate: sourceFps(s) ?? 24, start_offset_frames: 0, show_id: targetShowId };
  const offset = s.session.start_offset_frames;
  if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) body.start_offset_frames = offset;
  const episode = str(s.session.episode);
  if (episode !== undefined) body.episode = episode.slice(0, 80);
  const notes = str(s.session.notes);
  if (notes !== undefined) body.notes = notes.slice(0, 2000);
  return body;
}

interface Placed {
  studio: SnapshotStudio;
  show: SnapshotShow;
  session: SnapshotSession;
}

/** The snapshot's sessions under their studio and show, each once, in listing order. */
export function placedSessions(snapshot: Snapshot): Placed[] {
  const byId = new Map(snapshot.sessions.map((s) => [s.session_id, s]));
  const out: Placed[] = [];
  const seen = new Set<string>();
  for (const studio of snapshot.studios ?? []) {
    for (const show of studio.shows) {
      for (const id of show.session_ids) {
        const session = byId.get(id);
        if (session === undefined || seen.has(id)) continue;
        seen.add(id);
        out.push({ studio, show, session });
      }
    }
  }
  return out;
}

export interface CreatePlan {
  teams: { source_studio_id: string; name: string; action: 'create' | 'done'; target_team_id: string; reused?: boolean }[];
  shows: { source_show_id: string; source_studio_id: string; name: string; categories: number; action: 'create' | 'done'; target_show_id?: string; categories_set?: boolean }[];
  sessions: { source_session_id: string; source_show_id: string; title: string; frame_rate: number; action: 'create' | 'done'; target_session_id?: string }[];
  transcript_words: { source_session_id: string; total: number; done: number }[];
  transcript_paragraphs: { source_session_id: string; total: number }[];
  dashboards: { source_dashboard_id: string; source_session_id: string; title: string; action: 'create' | 'done'; target_dashboard_id?: string }[];
  not_copied: string[];
}

/** What --create would make, from the snapshot and the state file only. */
export function createPlan(snapshot: Snapshot, structure: Structure): CreatePlan {
  const plan: CreatePlan = { teams: [], shows: [], sessions: [], transcript_words: [], transcript_paragraphs: [], dashboards: [], not_copied: NOT_COPIED };
  for (const studio of snapshot.studios ?? []) {
    const team = structure.teams[studio.studio_id];
    const name = str(studio.studio.name) ?? studio.studio_id;
    plan.teams.push(
      team === undefined
        ? { source_studio_id: studio.studio_id, name, action: 'create', target_team_id: teamSlug(studio.studio_id) }
        : { source_studio_id: studio.studio_id, name, action: 'done', target_team_id: team.target_id, reused: team.reused },
    );
    for (const show of studio.shows) {
      const made = structure.shows[show.show_id];
      const entry: CreatePlan['shows'][number] = {
        source_show_id: show.show_id,
        source_studio_id: studio.studio_id,
        name: str(show.show.name) ?? show.show_id,
        categories: categoriesBody(show.categories).length,
        action: made === undefined ? 'create' : 'done',
      };
      if (made !== undefined) Object.assign(entry, { target_show_id: made.target_id, categories_set: made.categories_set === true });
      plan.shows.push(entry);
    }
  }
  for (const { show, session } of placedSessions(snapshot)) {
    const made = structure.sessions[session.session_id];
    const body = newSessionBody(session, '');
    plan.sessions.push({
      source_session_id: session.session_id,
      source_show_id: show.show_id,
      title: String(body.title),
      frame_rate: Number(body.frame_rate),
      action: made === undefined ? 'create' : 'done',
      ...(made !== undefined ? { target_session_id: made.target_id } : {}),
    });
    const words = session.transcript_words ?? [];
    if (words.length > 0) plan.transcript_words.push({ source_session_id: session.session_id, total: words.length, done: structure.words[session.session_id]?.done ?? 0 });
    const paragraphs = session.transcript_paragraphs ?? [];
    if (paragraphs.length > 0) plan.transcript_paragraphs.push({ source_session_id: session.session_id, total: paragraphs.length });
    for (const d of session.dashboards ?? []) {
      const id = str(d.dashboard_id);
      if (id === undefined) continue;
      const saved = structure.dashboards[id];
      plan.dashboards.push({
        source_dashboard_id: id,
        source_session_id: session.session_id,
        title: clip(str(d.title) ?? '', 80),
        action: saved === undefined ? 'create' : 'done',
        ...(saved !== undefined ? { target_dashboard_id: saved.target_id } : {}),
      });
    }
  }
  return plan;
}

/**
 * The target sessions events, topics and wiki pages go into: those --create made (`resolve`
 * reads them on the target), and, for a plan, the ones still to make as `new:<source id>`
 * placeholders at the source frame rate.
 */
export function plannedTargets(snapshot: Snapshot, structure: Structure): TargetSession[] {
  return placedSessions(snapshot).map(({ show, session }) => {
    const made = structure.sessions[session.session_id];
    const out: TargetSession = {
      source_session_id: session.session_id,
      target_session_id: made?.target_id ?? `new:${session.session_id}`,
      target_show_id: made?.target_show_id ?? structure.shows[show.show_id]?.target_id ?? `new:${show.show_id}`,
    };
    const fps = sourceFps(session);
    if (fps !== undefined) out.target_fps = fps;
    return out;
  });
}

export interface CreateInput {
  app: AppClient;
  snapshot: Snapshot;
  structure: Structure;
  save: () => void;
  result: CreateResult;
  notice: (text: string) => void;
}

/** Makes the teams, shows (with categories) and sessions still missing on the target. */
export async function createStructure(input: CreateInput): Promise<void> {
  const { app, snapshot, structure, save, result } = input;
  const fail = (kind: StructureKind, sourceId: string, reason: string): void => {
    result.failed.push({ kind, source_id: sourceId, reason });
  };
  const byId = new Map(snapshot.sessions.map((s) => [s.session_id, s]));

  for (const studio of snapshot.studios ?? []) {
    const team = await ensureTeam(input, studio, fail);
    if (team === undefined) continue;
    for (const show of studio.shows) {
      const made = await ensureShow(input, team, show, fail);
      if (made === undefined) continue;
      if (made.categories_set !== true) {
        const categories = categoriesBody(show.categories);
        if (categories.length > 0) {
          const answer = await app.call('PUT', '/api/profile', { active_studio_id: team, active_show_id: made.target_id, show_updates: [{ show_id: made.target_id, categories }] });
          if (answer.status === 200) {
            made.categories_set = true;
            save();
            result.categories_set++;
          } else {
            fail('categories', show.show_id, `PUT /api/profile (the show's categories) answered ${answer.status}: ${detailOf(answer)}; events of this show whose category is missing will fail`);
          }
        }
      }
      const todo = show.session_ids.filter((id) => structure.sessions[id] === undefined && byId.has(id));
      if (todo.length === 0) continue;
      // The app creates a session in the user's active team.
      const active = await app.call('PUT', '/api/profile', { active_studio_id: team, active_show_id: made.target_id });
      if (active.status !== 200) {
        fail('show', show.show_id, `cannot make team ${team} the active team (PUT /api/profile answered ${active.status}: ${detailOf(active)}); its sessions were not created`);
        continue;
      }
      for (const id of todo) {
        const session = byId.get(id) as SnapshotSession;
        const answer = await app.call('POST', '/api/sessions', newSessionBody(session, made.target_id));
        const targetId = isObject(answer.body) ? str(answer.body.id) : undefined;
        if (answer.status !== 200 || targetId === undefined) {
          fail('session', id, `POST /api/sessions answered ${answer.status}: ${detailOf(answer)}`);
          continue;
        }
        structure.sessions[id] = { target_id: targetId, target_show_id: made.target_id };
        save();
        result.sessions_created++;
      }
    }
  }
}

const TEAM_CAP_RE = /limit has been reached|already own/i;
const TEAM_TAKEN_RE = /already exists|not available/i;
const TEAM_TRIES = 5;

/** The target team of a studio: one made earlier, an existing one the user belongs to, or a new one. */
async function ensureTeam(input: CreateInput, studio: SnapshotStudio, fail: (k: StructureKind, id: string, r: string) => void): Promise<string | undefined> {
  const { app, structure, save, result } = input;
  const known = structure.teams[studio.studio_id];
  if (known !== undefined) return known.target_id;
  const base = teamSlug(studio.studio_id);
  const name = (str(studio.studio.name) ?? studio.studio_id).trim().slice(0, 200);
  const tried: string[] = [];
  for (let n = 1; n <= TEAM_TRIES; n++) {
    const id = n === 1 ? base : `${base.slice(0, 60).replace(/-+$/, '')}-${n}`;
    tried.push(id);
    const existing = await app.call('GET', `/api/teams/${encodeURIComponent(id)}`);
    if (existing.status === 200) {
      structure.teams[studio.studio_id] = { target_id: id, reused: true };
      save();
      result.teams_reused++;
      input.notice(`team ${id} already exists on ${app.server} and you belong to it: reusing it for studio ${studio.studio_id}\n`);
      return id;
    }
    if (existing.status !== 404) {
      fail('team', studio.studio_id, `GET /api/teams/${id} answered ${existing.status}: ${detailOf(existing)}; nothing of this studio was created`);
      return undefined;
    }
    const made = await app.call('POST', '/api/teams', { id, display_name: name });
    if (made.status === 200) {
      structure.teams[studio.studio_id] = { target_id: id, reused: false };
      save();
      result.teams_created++;
      return id;
    }
    const detail = detailOf(made);
    if (TEAM_CAP_RE.test(detail)) {
      fail('team', studio.studio_id, `you already own 20 teams on ${app.server}, autologger's limit (${detail}). Delete a team you own there, then run the same import --confirm again; nothing of this studio was created`);
      return undefined;
    }
    if (made.status === 400 && TEAM_TAKEN_RE.test(detail)) continue;
    fail('team', studio.studio_id, `POST /api/teams (id ${id}) answered ${made.status}: ${detail}; nothing of this studio was created`);
    return undefined;
  }
  fail('team', studio.studio_id, `the team ids ${tried.join(', ')} are all taken on ${app.server} by teams you do not belong to; nothing of this studio was created`);
  return undefined;
}

async function ensureShow(
  input: CreateInput,
  team: string,
  show: SnapshotShow,
  fail: (k: StructureKind, id: string, r: string) => void,
): Promise<Structure['shows'][string] | undefined> {
  const { app, structure, save, result } = input;
  const known = structure.shows[show.show_id];
  if (known !== undefined) return known;
  const body: Rec = { studio_id: team, name: (str(show.show.name) ?? show.show_id).trim().slice(0, 200) };
  const code = str(show.show.show_code);
  if (code !== undefined) body.show_code = code.trim().slice(0, 40);
  const answer = await app.call('POST', '/api/shows', body);
  const created = isObject(answer.body) && isObject(answer.body.show) ? str(answer.body.show.id) : undefined;
  if (answer.status !== 200 || created === undefined) {
    const role = answer.status === 403 ? ` (only an owner or admin of team ${team} can add shows)` : '';
    fail('show', show.show_id, `POST /api/shows answered ${answer.status}: ${detailOf(answer)}${role}; its sessions were not created`);
    return undefined;
  }
  const record = { target_id: created, target_team_id: team };
  structure.shows[show.show_id] = record;
  save();
  result.shows_created++;
  return record;
}

/** Adds each created session's transcript words still missing on the target, in snapshot order. */
export async function copyWords(input: CreateInput): Promise<void> {
  const { app, snapshot, structure, save, result } = input;
  for (const { session } of placedSessions(snapshot)) {
    const target = structure.sessions[session.session_id];
    const words = session.transcript_words ?? [];
    if (target === undefined || words.length === 0) continue;
    const progress = (structure.words[session.session_id] ??= { done: 0 });
    for (let i = progress.done; i < words.length; i++) {
      const w = words[i] as Rec;
      const body = { session_time: String(w.session_time ?? ''), speaker: String(w.speaker ?? ''), word: String(w.word ?? '') };
      const answer = await app.call('POST', `/api/sessions/${encodeURIComponent(target.target_id)}/transcript-words`, body);
      if (answer.status !== 200 && answer.status !== 201) {
        result.failed.push({
          kind: 'transcript_words',
          source_id: session.session_id,
          reason: `word ${i + 1} of ${words.length}: POST /api/sessions/${target.target_id}/transcript-words answered ${answer.status}: ${detailOf(answer)}; the rest of this session's words are tried again on the next run`,
        });
        break;
      }
      progress.done = i + 1;
      const id = isObject(answer.body) ? str(answer.body.id) : undefined;
      if (id !== undefined) progress.last_target_id = id;
      save();
      result.transcript_words_copied++;
    }
  }
}

/** Saves each created session's dashboards with the MCP `save_dashboard` tool; a refusal is a failure. */
export async function copyDashboards(input: CreateInput & { caller: Caller; tools: ReadonlyMap<string, Tool> }): Promise<void> {
  const { caller, tools, snapshot, structure, save, result } = input;
  const shape = inputShape(tools.get(DASHBOARD_TOOL));
  for (const { session } of placedSessions(snapshot)) {
    const target = structure.sessions[session.session_id];
    if (target === undefined) continue;
    for (const d of session.dashboards ?? []) {
      const sourceId = str(d.dashboard_id);
      if (sourceId === undefined || structure.dashboards[sourceId] !== undefined) continue;
      const args: Rec = { title: String(d.title ?? ''), tsx: String(d.tsx ?? ''), scope: { kind: 'session', session_id: target.target_id } };
      for (const key of Object.keys(args)) if (!shape.open && shape.properties.size > 0 && !shape.properties.has(key)) delete args[key];
      const answer = await callWithRetry(caller, DASHBOARD_TOOL, args);
      if (answer.isError === true) {
        result.failed.push({ kind: 'dashboard', source_id: sourceId, reason: `${DASHBOARD_TOOL} refused it: ${clip(resultText(answer), 500)}` });
        continue;
      }
      const sc = answer.structuredContent;
      const id = isObject(sc) ? str(sc.dashboard_id) : undefined;
      if (id === undefined) throw new CliError(`${DASHBOARD_TOOL} answered no dashboard_id for dashboard ${sourceId}; it may have been saved, check the target before running again`);
      structure.dashboards[sourceId] = { target_id: id, target_session_id: target.target_id };
      save();
      result.dashboards_saved++;
    }
  }
}
