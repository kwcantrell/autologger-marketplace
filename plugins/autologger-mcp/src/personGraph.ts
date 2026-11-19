// person-graph: a person's wiki page and what is around it, from the local index only: the pages it
// links to and the pages linking to it (one hop), the session moments it cites, and the session
// topics each moment falls in. Answered as nodes and edges plus a Mermaid diagram whose labels are
// escaped, so no title or summary can break out of its node.
import { CliError } from './errors.ts';
import { citeUrl, linkTargets } from './links.ts';
import { fold, sessionInfo, topicSpan } from './moments.ts';
import type { PageRecord, ScopeView } from './wikiIndex.ts';

export type NodeType = 'person' | 'page' | 'session' | 'moment' | 'topic';
export type EdgeType = 'links_to' | 'cites' | 'in_session' | 'during';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface PersonGraph {
  person: { page_id: string; title: string; aliases: string[] };
  nodes: GraphNode[];
  edges: GraphEdge[];
  mermaid: string;
}

/** Thrown when the index has no person page by that id, title or alias. */
export class PersonNotFound extends CliError {}

const MAX_LABEL = 60;

/**
 * A Mermaid node label, for use inside `["..."]`: whitespace (newlines too) collapsed, cut to
 * MAX_LABEL characters, and every character other than a letter, digit, mark, space or one of
 * `.,:!?'()-/@` written as Mermaid's `#<code>;` entity, so quotes, brackets, backticks, `#`, `<`,
 * `>`, `|` and Markdown characters stay text.
 */
export function mermaidLabel(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  const cut = chars.length > MAX_LABEL ? [...chars.slice(0, MAX_LABEL - 1), '…'] : chars;
  return cut.map((ch) => (/^[\p{L}\p{N}\p{M} .,:!?'()\-/@]$/u.test(ch) ? ch : `#${ch.codePointAt(0) ?? 0};`)).join('');
}

const EDGE_LABEL: Record<EdgeType, string> = { links_to: 'links to', cites: 'cites', in_session: 'in session', during: 'during' };

/** The Mermaid `graph LR` of nodes and edges; node ids are generated (`n0`, `n1`, ...), never data. */
export function toMermaid(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ['graph LR'];
  for (const n of nodes) lines.push(`  ${ids.get(n.id)}["${mermaidLabel(n.label)}"]`);
  for (const e of edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (from !== undefined && to !== undefined) lines.push(`  ${from} -->|${EDGE_LABEL[e.type]}| ${to}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The person pages of the view matching `name`: a page id exactly, else a title or alias (folded). */
export function findPerson(view: ScopeView, name: string): PageRecord[] {
  const people = [...view.pages.values()].filter((p) => p.kind === 'person');
  const byId = people.filter((p) => p.page_id === name);
  if (byId.length > 0) return byId;
  const want = fold(name.trim()).folded;
  return people.filter((p) => [p.title, ...p.aliases].some((t) => fold(t.trim()).folded === want)).sort((a, b) => a.page_id.localeCompare(b.page_id));
}

const fmtSeconds = (s: number): string => `${String(Math.round(s * 1000) / 1000)} s`;

export function personGraph(view: ScopeView, person: PageRecord): PersonGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addNode = (node: GraphNode): string => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = (from: string, to: string, type: EdgeType): void => {
    const key = `${from}\n${to}\n${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, type });
  };
  const pageNode = (pageId: string, type: NodeType = 'page'): string => {
    const page = view.pages.get(pageId);
    return addNode({
      id: `page:${pageId}`,
      type,
      label: page === undefined ? `page ${pageId} (not indexed)` : `${page.kind}: ${page.title}`,
      page_id: pageId,
      kind: page?.kind ?? null,
      title: page?.title ?? null,
      in_index: page !== undefined,
    });
  };

  const me = pageNode(person.page_id, 'person');
  const links = linkTargets(person.body_md);

  for (const l of links) {
    if (l.kind === 'wiki' && l.page_id !== person.page_id) addEdge(me, pageNode(l.page_id), 'links_to');
  }
  for (const page of [...view.pages.values()].sort((a, b) => a.page_id.localeCompare(b.page_id))) {
    if (page.page_id === person.page_id) continue;
    if (linkTargets(page.body_md).some((l) => l.kind === 'wiki' && l.page_id === person.page_id)) addEdge(pageNode(page.page_id), me, 'links_to');
  }

  const sessions = new Map(view.sessions.map((s) => [s.session_id, s]));
  for (const l of links) {
    if (l.kind !== 'cite') continue;
    const record = sessions.get(l.session_id);
    const info = record === undefined ? undefined : sessionInfo(record);
    const sessionNode = addNode({
      id: `session:${l.session_id}`,
      type: 'session',
      label: info === undefined ? `session ${l.session_id} (not indexed)` : `session: ${info.session_title || l.session_id}${info.session_date ? ` (${info.session_date})` : ''}`,
      session_id: l.session_id,
      title: info?.session_title ?? null,
      date: info?.session_date ?? null,
      in_index: info !== undefined,
    });
    const cite = citeUrl(l.session_id, l.seconds);
    const moment = addNode({
      id: `moment:${l.session_id}@${l.seconds}`,
      type: 'moment',
      label: `${fmtSeconds(l.seconds)}${l.label ? `: ${l.label}` : ''}`,
      session_id: l.session_id,
      seconds: l.seconds,
      cite,
      quote: l.label,
    });
    addEdge(me, moment, 'cites');
    addEdge(moment, sessionNode, 'in_session');
    if (record === undefined || info === undefined) continue;
    for (const topic of record.topics) {
      const span = topicSpan(topic, info.fps);
      if (span === undefined || l.seconds < span.start || l.seconds > span.end) continue;
      const topicId = typeof topic.id === 'string' || typeof topic.id === 'number' ? String(topic.id) : String(topic.ordinal ?? '');
      const summary = typeof topic.summary === 'string' ? topic.summary : '';
      const t = addNode({
        id: `topic:${l.session_id}:${topicId}`,
        type: 'topic',
        label: `topic: ${summary || topicId}`,
        session_id: l.session_id,
        topic_id: topicId,
        summary,
        start_sec: span.start,
        end_sec: Number.isFinite(span.end) ? span.end : null,
      });
      addEdge(moment, t, 'during');
      addEdge(t, sessionNode, 'in_session');
    }
  }

  const list = [...nodes.values()];
  return {
    person: { page_id: person.page_id, title: person.title, aliases: person.aliases },
    nodes: list,
    edges,
    mermaid: toMermaid(list, edges),
  };
}
