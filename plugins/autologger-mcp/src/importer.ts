// import: writes a snapshot's events, topics and wiki pages into existing sessions of a target
// server, through its MCP write tools. The write tools cannot create studios, shows, sessions or
// transcripts, so each source session is mapped by the user onto a target session.
//
// - Arguments are built from fixed rules per kind, then cut down to the fields the target tool's
//   inputSchema accepts (inputs are strict); every source field not sent is reported once.
// - Wiki bodies get their wiki:/cite: links rewritten to the target's ids. A page that links to a
//   page created after it is created first and its links fixed with update_wiki_page afterwards.
//   The state keeps a hash of the body last sent, so a page whose linked page is only created on a
//   later run (it failed, or its session was mapped later) is fixed then too.
// - Progress is kept in a state file next to the snapshot after every write, so a rerun creates no
//   duplicates. Content from the snapshot is only ever sent as tool arguments: it never picks a
//   tool, a server or a file.
import { createHash } from 'node:crypto';
import {
  type Caller,
  callWithRetry,
  type CreatedItem,
  idKeys,
  type ImportState,
  inputShape,
  type InputShape,
  itemId,
  itemKey,
  type Kind,
  KINDS,
  readTool,
  type Rec,
  type Snapshot,
  type TargetState,
} from './copy.ts';
import { CliError } from './errors.ts';
import { clip, isObject } from './http.ts';
import { checkLinks, rewriteLinks } from './links.ts';
import { resultText, type Tool } from './mcp.ts';

export const CREATE_TOOL: Record<Kind, string> = { events: 'create_event', topics: 'create_topic', wiki_pages: 'create_wiki_page' };
export const LINK_FIX_TOOL = 'update_wiki_page';

export type Action = 'create' | 'done' | 'skip' | 'fix-links';

export interface PlanItem {
  kind: Kind;
  source_id: string;
  source_session_id: string;
  target_session_id: string;
  label: string;
  action: Action;
  reason?: string;
  target_id?: string;
}

export interface DroppedField {
  tool: string;
  field: string;
}

export interface UnresolvedLink {
  source_page_id: string;
  link: string;
}

export interface Plan {
  items: PlanItem[];
  dropped_fields: DroppedField[];
  unresolved_links: UnresolvedLink[];
  /** The write tools the plan needs. */
  tools: string[];
}

export interface TargetSession {
  source_session_id: string;
  target_session_id: string;
  target_show_id: string | undefined;
}

interface Entry {
  kind: Kind;
  sourceId: string;
  sourceSessionId: string;
  target: TargetSession;
  item: Rec;
}

/** The snapshot items of the mapped sessions, each once (a show's page can be listed by several sessions). */
function entries(snapshot: Snapshot, targets: readonly TargetSession[]): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const kind of KINDS) {
    for (const target of targets) {
      const session = snapshot.sessions.find((s) => s.session_id === target.source_session_id);
      for (const item of session?.[kind] ?? []) {
        const sourceId = itemId(kind, item);
        if (sourceId === undefined) continue;
        const key = itemKey(kind, sourceId);
        const seen = byKey.get(key);
        // A session page belongs with the session whose own page it is.
        if (seen === undefined || (kind === 'wiki_pages' && item.association === 'session_page' && seen.item.association !== 'session_page')) {
          byKey.set(key, { kind, sourceId, sourceSessionId: target.source_session_id, target, item });
        }
      }
    }
  }
  return [...byKey.values()];
}

function label(kind: Kind, item: Rec): string {
  const text = kind === 'events' ? item.message : kind === 'topics' ? item.summary : item.title;
  return clip(typeof text === 'string' ? text : '', 80);
}

/**
 * The arguments of an item's create tool before the schema cut, the target ids filled in, or a
 * reason it cannot be created.
 */
function candidate(entry: Entry): { args: Rec } | { skip: string } {
  const { kind, item, target } = entry;
  const args: Rec = { ...item };
  for (const key of idKeys(kind)) delete args[key];
  delete args.session_id;
  delete args.show_id;
  if (kind === 'events') {
    // The target show's categories have other ids; a category's name resolves on the target.
    const internal = typeof item.category === 'string' && item.category.toLowerCase() === 'internal';
    if (!internal && typeof item.category_label === 'string' && item.category_label !== '') args.category = item.category_label;
    delete args.category_label;
    if ('wall_time_utc' in item) {
      args.marked_at_utc = item.wall_time_utc;
      delete args.wall_time_utc;
    }
    args.session_id = target.target_session_id;
  } else if (kind === 'topics') {
    args.session_id = target.target_session_id;
  } else {
    if (target.target_show_id === undefined) return { skip: `target session ${target.target_session_id} has no show_id` };
    args.show_id = target.target_show_id;
    if (item.kind === 'session') {
      if (item.association !== 'session_page') return { skip: 'the session page of a session that is not mapped' };
      args.session_id = target.target_session_id;
    }
  }
  return { args };
}

/** Cuts `args` down to what `shape` accepts; the fields cut, and missing required ones. */
function fit(args: Rec, shape: InputShape): { args: Rec; dropped: string[]; missing: string[] } {
  const out: Rec = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (shape.open || shape.properties.has(key)) out[key] = value;
    else dropped.push(key);
  }
  return { args: out, dropped, missing: shape.required.filter((r) => !(r in out)) };
}

function bodyOf(item: Rec): string {
  return typeof item.body_md === 'string' ? item.body_md : '';
}

export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface PlanInput {
  snapshot: Snapshot;
  targets: readonly TargetSession[];
  state: TargetState;
  tools: ReadonlyMap<string, Tool>;
}

/** What import would do, without writing anything. */
export function plan(input: PlanInput): Plan {
  const { state, tools } = input;
  const all = entries(input.snapshot, input.targets);
  const sourceToTarget = new Map(input.targets.map((t) => [t.source_session_id, t.target_session_id]));
  const items: PlanItem[] = [];
  const dropped = new Map<string, DroppedField>();
  const needed = new Set<string>();
  const toCreate = new Set<string>();

  for (const entry of all) {
    const key = itemKey(entry.kind, entry.sourceId);
    const base = {
      kind: entry.kind,
      source_id: entry.sourceId,
      source_session_id: entry.sourceSessionId,
      target_session_id: entry.target.target_session_id,
      label: label(entry.kind, entry.item),
    };
    const created = state.created[key];
    if (created !== undefined) {
      // Whether its links still need a rewrite is known once every page to create is (below).
      items.push({
        ...base,
        target_session_id: created.target_session_id,
        action: 'done',
        reason: 'created by an earlier run (state file)',
        target_id: created.target_id,
      });
      continue;
    }
    const skipped = state.skipped[key];
    if (skipped !== undefined) {
      items.push({ ...base, action: 'skip', reason: skipped.reason });
      continue;
    }
    const tool = CREATE_TOOL[entry.kind];
    const c = candidate(entry);
    if ('skip' in c) {
      items.push({ ...base, action: 'skip', reason: c.skip });
      continue;
    }
    const shape = inputShape(tools.get(tool));
    const fitted = fit(c.args, shape);
    for (const field of fitted.dropped) dropped.set(`${tool}\u0000${field}`, { tool, field });
    if (tools.has(tool) && fitted.missing.length > 0) {
      items.push({ ...base, action: 'skip', reason: `the snapshot has no ${fitted.missing.join(', ')}, which ${tool} on the target requires` });
      continue;
    }
    needed.add(tool);
    toCreate.add(entry.sourceId);
    items.push({ ...base, action: 'create' });
  }

  // Pages created by an earlier run whose body, rewritten with what the target will have, changes:
  // a page they link to is created only now, or was created after their last write.
  const createdTarget = (id: string): string | undefined => state.created[itemKey('wiki_pages', id)]?.target_id;
  for (const item of items) {
    if (item.kind !== 'wiki_pages' || item.action !== 'done') continue;
    const entry = all.find((e) => e.kind === 'wiki_pages' && e.sourceId === item.source_id);
    const record = state.created[itemKey('wiki_pages', item.source_id)];
    if (entry === undefined || record === undefined) continue;
    let comesNow = false;
    const rewritten = rewriteLinks(bodyOf(entry.item), {
      page: (id) => {
        if (toCreate.has(id) && createdTarget(id) === undefined) comesNow = true;
        return createdTarget(id);
      },
      session: (id) => sourceToTarget.get(id),
    });
    if (comesNow || record.body_sha256 !== bodyHash(rewritten.body)) {
      needed.add(LINK_FIX_TOOL);
      item.action = 'fix-links';
      item.reason = 'created earlier; its links to pages created after it are still to be rewritten';
    }
  }

  // Links: which resolve, and which pages will need a second write for links to later pages.
  const pageIds = new Set([...toCreate].filter((id) => all.some((e) => e.kind === 'wiki_pages' && e.sourceId === id)));
  for (const id of Object.keys(state.created)) if (id.startsWith('wiki_pages:')) pageIds.add(id.slice('wiki_pages:'.length));
  const unresolved: UnresolvedLink[] = [];
  const createdBefore = new Set(Object.keys(state.created).filter((k) => k.startsWith('wiki_pages:')).map((k) => k.slice('wiki_pages:'.length)));
  for (const item of items) {
    if (item.kind !== 'wiki_pages' || item.action !== 'create') continue;
    const entry = all.find((e) => e.kind === 'wiki_pages' && e.sourceId === item.source_id);
    let forward = false;
    const result = rewriteLinks(bodyOf(entry?.item ?? {}), {
      page: (id) => {
        if (!pageIds.has(id)) return undefined;
        if (!createdBefore.has(id) && id !== item.source_id) forward = true;
        return id;
      },
      session: (id) => sourceToTarget.get(id),
    });
    for (const link of result.unresolved) unresolved.push({ source_page_id: item.source_id, link });
    if (forward) {
      needed.add(LINK_FIX_TOOL);
      item.reason = 'links to pages created after it are rewritten with update_wiki_page afterwards';
    }
    createdBefore.add(item.source_id);
  }

  return { items, dropped_fields: [...dropped.values()], unresolved_links: unresolved, tools: [...needed].sort() };
}

export interface RunInput extends PlanInput {
  caller: Caller;
  /** Saves the state after each write. */
  save: () => void;
}

export interface Failure {
  kind: Kind;
  source_id: string;
  reason: string;
}

export interface RunResult {
  created: Record<Kind, number>;
  links_fixed: number;
  skipped: PlanItem[];
  failed: Failure[];
  unresolved_links: UnresolvedLink[];
}

const TAKEN_RE = /^(Title already used\.|Session already has a page\.) page_id: ([A-Za-z0-9_-]{1,200})/;

function createdId(kind: Kind, sc: unknown): { id: string | undefined; revision: number | undefined } {
  if (!isObject(sc)) return { id: undefined, revision: undefined };
  const revision = typeof sc.revision === 'number' ? sc.revision : undefined;
  return { id: itemId(kind, sc), revision };
}

/** Runs the plan's creates, then the link fixes; the state is saved after every write. */
export async function execute(input: RunInput, thePlan: Plan): Promise<RunResult> {
  const { state, tools, caller } = input;
  const all = entries(input.snapshot, input.targets);
  const sourceToTarget = new Map(input.targets.map((t) => [t.source_session_id, t.target_session_id]));
  const result: RunResult = { created: { events: 0, topics: 0, wiki_pages: 0 }, links_fixed: 0, skipped: [], failed: [], unresolved_links: [] };

  const pageTarget = (id: string): string | undefined => state.created[itemKey('wiki_pages', id)]?.target_id;

  for (const item of thePlan.items) {
    if (item.action === 'skip') result.skipped.push(item);
    if (item.action !== 'create') continue;
    const entry = all.find((e) => e.kind === item.kind && e.sourceId === item.source_id);
    if (entry === undefined) continue;
    const tool = CREATE_TOOL[item.kind];
    const c = candidate(entry);
    if ('skip' in c) continue;
    let sentHash: string | undefined;
    if (item.kind === 'wiki_pages') {
      const rewritten = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
      const problems = checkLinks(rewritten.body);
      if (problems.length > 0) {
        result.failed.push({ kind: item.kind, source_id: item.source_id, reason: `its body fails check-links (${problems.map((p) => `${p.line}:${p.column} ${p.text}`).join('; ')})` });
        continue;
      }
      c.args.body_md = rewritten.body;
      sentHash = bodyHash(rewritten.body);
    }
    const { args } = fit(c.args, inputShape(tools.get(tool)));
    const answer = await callWithRetry(caller, tool, args);
    const key = itemKey(item.kind, item.source_id);
    if (answer.isError === true) {
      const message = resultText(answer);
      const taken = TAKEN_RE.exec(message);
      if (item.kind === 'wiki_pages' && taken !== null) {
        const reason = `${taken[1]} on the target (page_id ${taken[2]}); not overwritten`;
        state.skipped[key] = { target_session_id: item.target_session_id, reason };
        input.save();
        result.skipped.push({ ...item, action: 'skip', reason });
      } else {
        result.failed.push({ kind: item.kind, source_id: item.source_id, reason: `${tool} refused it: ${clip(message, 500)}` });
      }
      continue;
    }
    const { id, revision } = createdId(item.kind, answer.structuredContent);
    if (id === undefined) throw new CliError(`${tool} answered no id for ${item.kind} ${item.source_id}; the item may have been created, check the target before running again`);
    const record: CreatedItem = { target_id: id, target_session_id: item.target_session_id };
    if (item.kind === 'wiki_pages') {
      if (revision !== undefined) record.revision = revision;
      if (sentHash !== undefined) record.body_sha256 = sentHash;
    }
    state.created[key] = record;
    input.save();
    result.created[item.kind]++;
  }

  // Pages whose links named pages that did not exist when they were last written (in this run or
  // an earlier one): rewrite them now. Only pages of the mapped sessions, whose cite: links resolve.
  for (const entry of all) {
    if (entry.kind !== 'wiki_pages') continue;
    const sourceId = entry.sourceId;
    const record = state.created[itemKey('wiki_pages', sourceId)];
    if (record === undefined) continue;
    const rewritten = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
    const hash = bodyHash(rewritten.body);
    if (record.body_sha256 === hash) continue;
    if (!tools.has(LINK_FIX_TOOL)) throw new CliError(`the target server has no ${LINK_FIX_TOOL} tool, needed to fix the links of copied wiki pages`);
    const { args } = fit({ page_id: record.target_id, expected_revision: record.revision, body_md: rewritten.body }, inputShape(tools.get(LINK_FIX_TOOL)));
    const answer = await callWithRetry(caller, LINK_FIX_TOOL, args);
    if (answer.isError === true) {
      result.failed.push({ kind: 'wiki_pages', source_id: sourceId, reason: `${LINK_FIX_TOOL} refused the link rewrite: ${clip(resultText(answer), 500)}` });
      continue;
    }
    const { revision } = createdId('wiki_pages', answer.structuredContent);
    record.revision = revision ?? (record.revision === undefined ? undefined : record.revision + 1);
    record.body_sha256 = hash;
    input.save();
    result.links_fixed++;
  }

  // The links left as they were, now that everything that could be created is.
  for (const entry of all) {
    if (entry.kind !== 'wiki_pages' || state.created[itemKey('wiki_pages', entry.sourceId)] === undefined) continue;
    const { unresolved } = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
    for (const link of unresolved) result.unresolved_links.push({ source_page_id: entry.sourceId, link });
  }
  return result;
}

/** The target's session, or a CliError when it does not exist or the user cannot see it. */
export async function targetSession(caller: Caller, server: string, source: string, target: string): Promise<TargetSession> {
  let session: Rec;
  try {
    session = await readTool(caller, 'get_session', { session_id: target });
  } catch (error) {
    throw new CliError(`target session ${target} cannot be read on ${server} (it does not exist or you cannot see it): ${(error as Error).message}`);
  }
  const show = session.show_id;
  return { source_session_id: source, target_session_id: target, target_show_id: typeof show === 'string' && show !== '' ? show : undefined };
}

export function emptyTargetState(): TargetState {
  return { created: {}, skipped: {} };
}

export function targetState(state: ImportState, server: string): TargetState {
  let target = state.targets[server];
  if (target === undefined) {
    target = emptyTargetState();
    state.targets[server] = target;
  }
  return target;
}
