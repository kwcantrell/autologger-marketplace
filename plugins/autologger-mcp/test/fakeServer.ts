// A local stand-in for autologger's OAuth server and MCP endpoint, faithful to the parts the CLI
// relies on (docs/specs/mcp-authorization.md and mcp-session-data.md in autologger): discovery,
// dynamic client registration, authorization code + PKCE S256 with `iss`, refresh rotation with
// reuse detection that revokes the grant, revocation, and a stateless Streamable HTTP /mcp with a
// bearer check. Endpoint paths are deliberately not autologger's, so the tests prove that the CLI
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
}

interface Grant {
  id: string;
  client_id: string;
  scope: string;
  revoked: boolean;
}

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
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, cursor: { type: 'string' } } },
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
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_wiki_page',
    description: 'A wiki page.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, page_id: { type: 'string' } } },
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
  inputSchema: { type: 'object' },
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
        const all = [...READ_TOOLS, ...(canWrite ? WRITE_TOOLS : [])];
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

/** Plays the browser: follows the authorization URL to the loopback callback. */
export async function browse(authorizationUrl: string): Promise<void> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) throw new Error(`authorize answered ${response.status} with no redirect`);
  await (await fetch(location)).text();
}
