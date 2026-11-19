// A local stand-in for autologger's OAuth server and MCP endpoint, faithful to the parts the CLI
// relies on (docs/specs/mcp-authorization.md and mcp-session-data.md in autologger): discovery,
// dynamic client registration, authorization code + PKCE S256 with `iss`, refresh rotation with
// reuse detection that revokes the grant, revocation, and a stateless Streamable HTTP /mcp with a
// bearer check, plus a stand-in for the dev-only `make dev-mcp-token` (`mintDevTokens`). Endpoint paths are deliberately not autologger's, so the tests prove that the CLI
// discovers them.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const WRITE_SCOPE_REFUSAL =
  'Not allowed: this connection lacks the session-data:write permission ("Edit events, topics and wiki pages"). Nothing was written. Reconnect AutoLogger and approve editing to use this tool.';

export interface FakeOptions {
  /** When false, the "user" unticks the write line at consent: grants hold `dashboards` only. */
  grantWrite?: boolean;
  /** Access token lifetime in seconds. */
  accessTtl?: number;
  /** Answer /mcp requests as text/event-stream instead of JSON. */
  sse?: boolean;
  /** Omit `iss` from the authorization response (the metadata still says it is supported). */
  omitIss?: boolean;
  /** Advertise a different issuer in the AS metadata than the PRM names. */
  wrongIssuer?: boolean;
  /** Omit the revocation endpoint from the metadata. */
  noRevocation?: boolean;
  /** Answer every /mcp request 401, whatever its token. */
  rejectAllBearers?: boolean;
  /**
   * Session data: the read and write tools then work on it the way autologger's do (strict inputs,
   * paged lists, sliced wiki bodies, categories by id or name, unique wiki titles per show).
   * Without it, every read tool answers one placeholder item and every write tool succeeds.
   */
  data?: FakeData;
  /** Items per list page in data mode (default 2). */
  pageSize?: number;
  /** Characters per get_wiki_page slice in data mode (default 40). */
  sliceChars?: number;
  /** After this many successful writes, refuse the next `rateLimitTimes` writes with a rate limit. */
  rateLimitAfterWrites?: number;
  rateLimitTimes?: number;
  /** The N of `Rate limit exceeded; retry in N s.` (default 7). */
  rateLimitRetryS?: number;
  /** Answer the write call with this 1-based number HTTP 500, once, writing nothing. */
  failWriteNumber?: number;
  /** Answer the write call with this 1-based number the tool error `Internal error.`, once, writing nothing. */
  toolErrorWriteNumber?: number;
  /** Replace these tools' inputSchema in tools/list (and in the strict input check). */
  inputSchemas?: Record<string, Record<string, unknown>>;
  /** Leave these tools out of tools/list (calling them answers "not found"). */
  omitTools?: string[];
}

export interface FakeSession {
  session_id: string;
  show_id: string;
  title?: string;
  /** The show's event categories (id and name); create_event takes either. */
  categories?: { id: string; label: string }[];
  events: Record<string, unknown>[];
  topics: Record<string, unknown>[];
}

export interface FakePage {
  page_id: string;
  show_id: string;
  kind: string;
  title: string;
  aliases: string[];
  body_md: string;
  revision: number;
  /** For a kind 'session' page: its session. */
  session_id?: string;
}

export interface FakeData {
  sessions: FakeSession[];
  pages: FakePage[];
}

interface Grant {
  id: string;
  client_id: string;
  scope: string;
  revoked: boolean;
}

function strict(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** The write tools' inputs as autologger-2 declares them (server/src/dashboards/mcpWriteTools.ts). */
const WRITE_SCHEMAS: Record<string, Record<string, unknown>> = {
  create_event: strict(
    { session_id: { type: 'string' }, category: { type: 'string' }, message: { type: 'string' }, metadata: { type: 'object' }, marked_at_utc: { type: ['string', 'null'] } },
    ['session_id', 'category', 'message'],
  ),
  create_topic: strict(
    { session_id: { type: 'string' }, session_time: { type: 'string' }, duration_sec: { type: 'number' }, topic_level: { type: 'integer' }, summary: { type: 'string' } },
    ['session_id'],
  ),
  create_wiki_page: strict(
    { show_id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, body_md: { type: 'string' }, aliases: { type: 'array' }, session_id: { type: 'string' } },
    ['show_id', 'kind', 'title'],
  ),
  update_wiki_page: strict(
    { page_id: { type: 'string' }, expected_revision: { type: 'integer' }, title: { type: 'string' }, kind: { type: 'string' }, body_md: { type: 'string' }, aliases: { type: 'array' } },
    ['page_id', 'expected_revision'],
  ),
};

const READ_TOOLS = [
  {
    name: 'list_studios',
    description: 'The studios the user belongs to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_shows',
    description: "A studio's shows.",
    inputSchema: { type: 'object', properties: { studio_id: { type: 'string' } }, required: ['studio_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_sessions',
    description: "A show's sessions.",
    inputSchema: { type: 'object', properties: { show_id: { type: 'string' } }, required: ['show_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_session',
    description: 'One session.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_events',
    description: "A session's events.",
    inputSchema: strict({ session_id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, ['session_id']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_topics',
    description: "A session's topics.",
    inputSchema: strict({ session_id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, ['session_id']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_transcript_paragraphs',
    description: "A session's transcript paragraphs.",
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_wiki_pages',
    description: "A session's wiki pages.",
    inputSchema: strict({ session_id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, ['session_id']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_wiki_page',
    description: 'A wiki page.',
    inputSchema: strict(
      { session_id: { type: 'string' }, page_id: { type: 'string' }, offset: { type: 'integer' }, max_chars: { type: 'integer' } },
      ['session_id', 'page_id'],
    ),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail_tool',
    description: 'Always answers a tool error.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
];
const WRITE_TOOL_NAMES = [
  'create_event',
  'update_event',
  'delete_event',
  'create_topic',
  'update_topic',
  'delete_topic',
  'create_wiki_page',
  'update_wiki_page',
  'delete_wiki_page',
];
const WRITE_TOOLS = WRITE_TOOL_NAMES.map((name) => ({
  name,
  description: `${name}. Ask the user to confirm before you delete anything.`,
  inputSchema: WRITE_SCHEMAS[name] ?? { type: 'object' },
  annotations: { readOnlyHint: false, destructiveHint: name.startsWith('delete') },
}));

const token = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

function loopbackMatch(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(a.hostname)) return false;
    return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && b.protocol === 'http:';
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export class FakeAutologger {
  readonly options: FakeOptions;
  base = '';
  private server: Server;
  readonly clients = new Map<string, { redirect_uris: string[] }>();
  readonly codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; scope: string; grant: Grant }>();
  readonly grants: Grant[] = [];
  readonly access = new Map<string, { grant: Grant; expires: number }>();
  readonly refresh = new Map<string, { grant: Grant; used: boolean }>();
  /** Every token this server issued, for the non-disclosure checks. */
  readonly issued: string[] = [];
  readonly calls: { method: string; path: string; rpc?: string; tool?: string; arguments?: unknown }[] = [];
  readonly counts = { registrations: 0, refreshes: 0, revocations: 0, reuses: 0 };
  /** Data mode: write tool calls answered (any outcome), successful writes, rate-limit refusals. */
  readonly writeCounts = { attempted: 0, succeeded: 0, rateLimited: 0, failed500: 0 };
  private nextId = 1;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get resource(): string {
    return `${this.base}/rpc/mcp`;
  }

  /** Server-side revocation of every grant (as under Connected apps). */
  revokeAll(): void {
    for (const g of this.grants) g.revoked = true;
    this.access.clear();
  }

  /**
   * Plays autologger's dev-only `make dev-mcp-token`: registers a client (unless `clientId` names
   * one), creates a grant without the consent flow and issues its tokens, and returns the JSON line
   * the real command prints (autologger-2 server/src/devMcpToken.ts), as text.
   */
  mintDevTokens(scope = 'dashboards', clientId?: string): string {
    let id = clientId;
    if (id === undefined) {
      id = `alc_${randomBytes(16).toString('base64url')}`;
      this.clients.set(id, { redirect_uris: ['http://127.0.0.1/callback'] });
      this.counts.registrations++;
    }
    const grant: Grant = { id: randomBytes(8).toString('hex'), client_id: id, scope, revoked: false };
    this.grants.push(grant);
    const tokens = this.issue(grant);
    return `${JSON.stringify({
      issuer: this.base,
      resource: this.resource,
      client_id: id,
      scope: tokens.scope,
      token_type: 'Bearer',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
    })}\n`;
  }

  /** Forget the access tokens only, so the next /mcp call answers 401. */
  dropAccessTokens(): void {
    this.access.clear();
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
  }

  private issue(grant: Grant): Record<string, unknown> {
    const access = token('alm_');
    const refresh = token('alr_');
    this.issued.push(access, refresh);
    this.access.set(access, { grant, expires: Date.now() + (this.options.accessTtl ?? 3600) * 1000 });
    this.refresh.set(refresh, { grant, used: false });
    return { access_token: access, token_type: 'Bearer', expires_in: this.options.accessTtl ?? 3600, refresh_token: refresh, scope: grant.scope };
  }

  private revokeGrant(grant: Grant): void {
    grant.revoked = true;
    for (const [k, v] of this.access) if (v.grant === grant) this.access.delete(k);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    this.calls.push({ method, path });
    const issuer = this.base;

    if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return this.json(res, 200, {
        resource: this.resource,
        authorization_servers: [issuer],
        scopes_supported: ['dashboards', 'session-data:write'],
        bearer_methods_supported: ['header'],
        resource_name: 'AutoLogger',
      });
    }
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return this.json(res, 200, {
        issuer: this.options.wrongIssuer ? 'https://evil.example' : issuer,
        authorization_endpoint: `${issuer}/as/v2/authorize`,
        token_endpoint: `${issuer}/as/v2/token`,
        registration_endpoint: `${issuer}/as/v2/register`,
        ...(this.options.noRevocation ? {} : { revocation_endpoint: `${issuer}/as/v2/revoke` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['dashboards', 'session-data:write'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (method === 'POST' && path === '/as/v2/register') {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return this.json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const id = `alc_${randomBytes(16).toString('base64url')}`;
      this.clients.set(id, { redirect_uris: body.redirect_uris });
      this.counts.registrations++;
      return this.json(res, 201, { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (method === 'GET' && path === '/as/v2/authorize') {
      const p = url.searchParams;
      const client = this.clients.get(p.get('client_id') ?? '');
      const redirect = p.get('redirect_uri') ?? '';
      if (client === undefined || !client.redirect_uris.some((r) => loopbackMatch(r, redirect))) {
        res.writeHead(400, { 'content-type': 'text/html' }).end('<p>Unknown app</p>');
        return;
      }
      const back = new URL(redirect);
      const state = p.get('state');
      const fail = (error: string): void => {
        back.searchParams.set('error', error);
        if (state !== null) back.searchParams.set('state', state);
        back.searchParams.set('iss', issuer);
        res.writeHead(302, { location: back.toString() }).end();
      };
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_challenge') ?? '') || state === null) {
        return fail('invalid_request');
      }
      if (p.get('resource') !== this.resource) return fail('invalid_target');
      const requested = p.get('scope') ?? 'dashboards';
      if (requested !== 'dashboards' && requested !== 'dashboards session-data:write') return fail('invalid_scope');
      const scope = this.options.grantWrite === false ? 'dashboards' : requested;
      const grant: Grant = { id: randomBytes(8).toString('hex'), client_id: p.get('client_id') ?? '', scope, revoked: false };
      this.grants.push(grant);
      const code = randomBytes(24).toString('base64url');
      this.codes.set(code, { client_id: grant.client_id, redirect_uri: redirect, challenge: p.get('code_challenge') ?? '', scope, grant });
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      if (!this.options.omitIss) back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (method === 'POST' && path === '/as/v2/token') {
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get('grant_type');
      if (form.get('resource') !== null && form.get('resource') !== this.resource) return this.json(res, 400, { error: 'invalid_target' });
      if (grantType === 'authorization_code') {
        const code = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        if (!this.clients.has(form.get('client_id') ?? '')) return this.json(res, 400, { error: 'invalid_client' });
        const verifier = form.get('code_verifier') ?? '';
        if (
          code === undefined ||
          code.client_id !== form.get('client_id') ||
          code.redirect_uri !== form.get('redirect_uri') ||
          createHash('sha256').update(verifier).digest('base64url') !== code.challenge
        ) {
          return this.json(res, 400, { error: 'invalid_grant' });
        }
        return this.json(res, 200, this.issue(code.grant));
      }
      if (grantType === 'refresh_token') {
        const presented = form.get('refresh_token') ?? '';
        const row = this.refresh.get(presented);
        this.counts.refreshes++;
        if (row === undefined || row.grant.revoked) return this.json(res, 400, { error: 'invalid_grant' });
        if (row.used) {
          // Reuse outside any grace window: revoke the whole grant.
          this.counts.reuses++;
          this.revokeGrant(row.grant);
          return this.json(res, 400, { error: 'invalid_grant' });
        }
        if (row.grant.client_id !== form.get('client_id')) return this.json(res, 400, { error: 'invalid_grant' });
        row.used = true;
        return this.json(res, 200, this.issue(row.grant));
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (method === 'POST' && path === '/as/v2/revoke') {
      const form = new URLSearchParams(await readBody(req));
      const presented = form.get('token') ?? '';
      const grant = this.refresh.get(presented)?.grant ?? this.access.get(presented)?.grant;
      if (grant !== undefined && grant.client_id === form.get('client_id')) {
        this.revokeGrant(grant);
        this.counts.revocations++;
      }
      res.writeHead(200).end();
      return;
    }
    if (path === '/rpc/mcp') return this.mcp(req, res);
    this.json(res, 404, { detail: 'Not Found' });
  }

  private schemaOf(name: string): Record<string, unknown> | undefined {
    const override = this.options.inputSchemas?.[name];
    if (override !== undefined) return override;
    return [...READ_TOOLS, ...WRITE_TOOLS].find((t) => t.name === name)?.inputSchema as Record<string, unknown> | undefined;
  }

  /** Data mode: one tool call on `options.data`, as autologger answers it. */
  private dataCall(name: string, args: Record<string, unknown>, canWrite: boolean): Record<string, unknown> | 'http500' {
    const data = this.options.data as FakeData;
    const text = (t: string): Record<string, unknown> => ({ result: { content: [{ type: 'text', text: t }], isError: true } });
    const ok = (out: Record<string, unknown>): Record<string, unknown> => ({
      result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out },
    });
    if ((this.options.omitTools ?? []).includes(name) || ![...READ_TOOLS, ...WRITE_TOOLS].some((t) => t.name === name)) {
      return { error: { code: -32602, message: `MCP error -32602: Tool ${name} not found` } };
    }
    // Strict inputs, as the SDK parses them before the tool runs.
    const schema = this.schemaOf(name);
    const props = isObjectRecord(schema?.properties) ? Object.keys(schema.properties) : undefined;
    if (props !== undefined && schema?.additionalProperties === false) {
      const unknown = Object.keys(args).filter((k) => !props.includes(k));
      if (unknown.length > 0) return text(`MCP error -32602: Input validation error: Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(', ')}`);
    }
    const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
    const missing = required.filter((k) => args[k] === undefined);
    if (missing.length > 0) return text(`MCP error -32602: Input validation error: Required: ${missing.join(', ')}`);

    const session = (id: unknown) => data.sessions.find((s) => s.session_id === id);
    const page = <T>(items: T[]): Record<string, unknown> => {
      const size = this.options.pageSize ?? 2;
      const cursor = typeof args.cursor === 'string' ? Number(args.cursor.replace(/^c/, '')) : 0;
      const slice = items.slice(cursor, cursor + size);
      const next = cursor + size < items.length ? `c${cursor + size}` : null;
      return { items: slice, next_cursor: next, total: items.length, truncated: false };
    };
    const associated = (s: FakeSession) =>
      data.pages
        .filter((p) => p.show_id === s.show_id)
        .map((p) => {
          const own = data.pages.find((q) => q.session_id === s.session_id);
          const association =
            p.session_id === s.session_id
              ? 'session_page'
              : p.body_md.includes(`cite:${s.session_id}@`)
                ? 'cites_session'
                : own !== undefined && own.body_md.includes(`wiki:${p.page_id})`)
                  ? 'linked_from_session_page'
                  : undefined;
          return { p, association };
        })
        .filter((x) => x.association !== undefined);

    if (WRITE_TOOL_NAMES.includes(name)) {
      if (!canWrite) return text(WRITE_SCOPE_REFUSAL);
      this.writeCounts.attempted++;
      if (this.options.failWriteNumber === this.writeCounts.attempted) {
        this.writeCounts.failed500++;
        return 'http500';
      }
      if (this.options.toolErrorWriteNumber === this.writeCounts.attempted) return text('Internal error.');
      const after = this.options.rateLimitAfterWrites;
      if (after !== undefined && this.writeCounts.succeeded >= after && this.writeCounts.rateLimited < (this.options.rateLimitTimes ?? 1)) {
        this.writeCounts.rateLimited++;
        return text(`Rate limit exceeded; retry in ${this.options.rateLimitRetryS ?? 7} s.`);
      }
      const done = (out: Record<string, unknown>): Record<string, unknown> => {
        this.writeCounts.succeeded++;
        return ok(out);
      };
      const id = (prefix: string) => `${prefix}${this.nextId++}`;
      switch (name) {
        case 'create_event': {
          const s = session(args.session_id);
          if (s === undefined) return text('Session not found');
          const wanted = String(args.category);
          const cats = s.categories ?? [];
          const cat =
            wanted === 'internal'
              ? { id: 'internal', label: 'Internal' }
              : (cats.find((c) => c.id === wanted) ?? cats.find((c) => c.label.trim().toLowerCase() === wanted.trim().toLowerCase()));
          if (cat === undefined) {
            return text(`Unknown category. Send a category id or name. Nothing was written. Valid categories: ${cats.map((c) => `${c.label} (${c.id})`).join(', ') || 'none'}, or internal.`);
          }
          const row = {
            event_id: id('ev_'),
            wall_time_utc: args.marked_at_utc ?? '2026-11-19T12:00:00.000Z',
            category: cat.id,
            category_label: cat.label,
            message: args.message,
            metadata: args.metadata ?? {},
            version: 1,
          };
          s.events.push(row);
          return done(row);
        }
        case 'create_topic': {
          const s = session(args.session_id);
          if (s === undefined) return text('Session not found');
          const row = {
            id: id('tp_'),
            session_time: args.session_time ?? '',
            duration_sec: args.duration_sec ?? 0,
            topic_level: args.topic_level ?? 1,
            summary: args.summary ?? '',
            ordinal: s.topics.length + 1,
            version: 1,
          };
          s.topics.push(row);
          return done(row);
        }
        case 'create_wiki_page': {
          const showId = String(args.show_id);
          if (!data.sessions.some((s) => s.show_id === showId)) return text('Show not found.');
          const title = String(args.title);
          const taken = data.pages.find((p) => p.show_id === showId && p.title.toLowerCase() === title.toLowerCase());
          if (taken !== undefined) return text(`Title already used. page_id: ${taken.page_id}`);
          if (args.kind === 'session') {
            if (args.session_id === undefined) return text('session_id: required for a session page');
            const has = data.pages.find((p) => p.session_id === args.session_id);
            if (has !== undefined) return text(`Session already has a page. page_id: ${has.page_id}`);
          } else if (args.session_id !== undefined) {
            return text('session_id: only for a session page');
          }
          const row: FakePage = {
            page_id: id('pg_'),
            show_id: showId,
            kind: String(args.kind),
            title,
            aliases: Array.isArray(args.aliases) ? (args.aliases as string[]) : [],
            body_md: typeof args.body_md === 'string' ? args.body_md : '',
            revision: 1,
            ...(typeof args.session_id === 'string' ? { session_id: args.session_id } : {}),
          };
          data.pages.push(row);
          return done({ ...row });
        }
        case 'update_wiki_page': {
          const p = data.pages.find((q) => q.page_id === args.page_id);
          if (p === undefined) return text('Wiki page not found');
          if (p.revision !== args.expected_revision) return text(`Version conflict: nothing was written. The current row is ${JSON.stringify(p)}`);
          if (typeof args.title === 'string') p.title = args.title;
          if (typeof args.body_md === 'string') p.body_md = args.body_md;
          p.revision++;
          return done({ ...p });
        }
        default:
          return text(`${name} is not played by the fake`);
      }
    }

    switch (name) {
      case 'get_session': {
        const s = session(args.session_id);
        if (s === undefined) return text('Session not found');
        return ok({
          session_id: s.session_id,
          show_id: s.show_id,
          studio_id: 'st_1',
          title: s.title ?? s.session_id,
          date: '2026-11-19',
          fps: 25,
          counts: { events: s.events.length, words: 0, paragraphs: 0, topics: s.topics.length, wiki_pages: associated(s).length },
          revision: 1,
        });
      }
      case 'list_events':
      case 'list_topics': {
        const s = session(args.session_id);
        if (s === undefined) return text('Session not found');
        return ok(page(name === 'list_events' ? s.events : s.topics));
      }
      case 'list_wiki_pages': {
        const s = session(args.session_id);
        if (s === undefined) return text('Session not found');
        return ok(
          page(
            associated(s).map(({ p, association }) => ({
              page_id: p.page_id,
              kind: p.kind,
              title: p.title,
              aliases: p.aliases,
              revision: p.revision,
              association,
              body_chars: p.body_md.length,
            })),
          ),
        );
      }
      case 'get_wiki_page': {
        const s = session(args.session_id);
        if (s === undefined) return text('Session not found');
        const found = associated(s).find((x) => x.p.page_id === args.page_id)?.p;
        if (found === undefined) return text('Wiki page not found');
        const offset = typeof args.offset === 'number' ? args.offset : 0;
        const end = offset + (this.options.sliceChars ?? 40);
        return ok({
          page_id: found.page_id,
          kind: found.kind,
          title: found.title,
          revision: found.revision,
          body_md: found.body_md.slice(offset, end),
          offset,
          next_offset: end < found.body_md.length ? end : null,
          body_chars: found.body_md.length,
        });
      }
      default:
        return ok({ items: [], next_cursor: null, total: 0, truncated: false });
    }
  }

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.json(res, 405, { detail: 'Method Not Allowed' }, { allow: 'POST' });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const row = bearer === undefined ? undefined : this.access.get(bearer);
    if (row === undefined || row.expires < Date.now() || row.grant.revoked || this.options.rejectAllBearers) {
      await readBody(req);
      return this.json(res, 401, { detail: 'Login required.' }, {
        'www-authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp", scope="dashboards session-data:write"`,
      });
    }
    const accept = req.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return this.json(res, 406, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not Acceptable' } });
    }
    const message = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: Record<string, unknown> };
    const call = this.calls[this.calls.length - 1];
    if (call !== undefined) call.rpc = message.method;
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const canWrite = row.grant.scope.split(' ').includes('session-data:write');
    const answer = (payload: Record<string, unknown>): void => {
      const body = { jsonrpc: '2.0', id: message.id, ...payload };
      if (this.options.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      } else {
        this.json(res, 200, body);
      }
    };
    const text = (t: string, isError = false): Record<string, unknown> => ({
      result: { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) },
    });
    switch (message.method) {
      case 'initialize':
        return answer({
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'autologger', version: 'fake' } },
        });
      case 'tools/list': {
        const omit = this.options.omitTools ?? [];
        const all = [...READ_TOOLS, ...(canWrite ? WRITE_TOOLS : [])]
          .filter((t) => !omit.includes(t.name))
          .map((t) => (this.options.inputSchemas?.[t.name] !== undefined ? { ...t, inputSchema: this.options.inputSchemas[t.name] } : t));
        // Two pages, to exercise nextCursor.
        const second = message.params?.cursor === 'page-2';
        return answer({ result: second ? { tools: all.slice(3) } : { tools: all.slice(0, 3), nextCursor: 'page-2' } });
      }
      case 'tools/call': {
        const name = String(message.params?.name);
        const args = message.params?.arguments;
        if (call !== undefined) {
          call.tool = name;
          call.arguments = args;
        }
        if (name === 'fail_tool') return answer(text('Session not found', true));
        if (this.options.data !== undefined) {
          const out = this.dataCall(name, isObjectRecord(args) ? args : {}, canWrite);
          if (out === 'http500') {
            res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error');
            return;
          }
          return answer(out);
        }
        if (WRITE_TOOL_NAMES.includes(name)) {
          if (!canWrite) return answer(text(WRITE_SCOPE_REFUSAL, true));
          return answer({ result: { content: [{ type: 'text', text: `${name} done` }], structuredContent: { ok: true, arguments: args } } });
        }
        if (READ_TOOLS.some((t) => t.name === name)) {
          return answer({
            result: {
              content: [{ type: 'text', text: `${name}: 1 item` }],
              structuredContent: { items: [{ id: 'X1', arguments: args }], next_cursor: null, total: 1, truncated: false },
            },
          });
        }
        return answer({ error: { code: -32602, message: `MCP error -32602: Tool ${name} not found` } });
      }
      default:
        return answer({ error: { code: -32601, message: 'Method not found' } });
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plays the browser: follows the authorization URL to the loopback callback. */
export async function browse(authorizationUrl: string): Promise<void> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) throw new Error(`authorize answered ${response.status} with no redirect`);
  await (await fetch(location)).text();
}
