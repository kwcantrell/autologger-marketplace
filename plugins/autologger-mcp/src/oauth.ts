// OAuth 2.1 client for autologger's authorization server: discovery (RFC 9728 + RFC 8414),
// dynamic client registration (RFC 7591), authorization code + PKCE S256 through a loopback
// redirect (RFC 8252), refresh with rotation, and revocation (RFC 7009).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError } from './errors.ts';
import { clip, type Fetch, isObject, jsonBody, request, requireAllowedUrl } from './http.ts';
import type { ClientRegistration, ServerEndpoints } from './store.ts';

export const READ_SCOPE = 'dashboards';
export const WRITE_SCOPE = 'session-data:write';
export const CLIENT_NAME = 'autologger-mcp CLI';
/** Registered once; the server matches a loopback redirect URI on any port (RFC 8252 7.3). */
export const REDIRECT_URI_REGISTERED = 'http://127.0.0.1/callback';

export interface Discovery extends ServerEndpoints {
  scopes_supported: string[];
  iss_parameter_supported: boolean;
}

async function getJson(fetchFn: Fetch, url: string, what: string): Promise<Record<string, unknown>> {
  const response = await request(fetchFn, url, { headers: { accept: 'application/json' } });
  const body = await jsonBody(response);
  if (response.status !== 200 || !isObject(body)) {
    throw new CliError(`${what} at ${url} answered ${response.status}${isObject(body) ? '' : ' with no JSON document'}`);
  }
  return body;
}

/** RFC 8414 section 3: the metadata URL of an issuer, `.well-known` inserted before any path. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

/** Finds the MCP resource and its authorization server's endpoints from the server's origin. */
export async function discover(fetchFn: Fetch, server: string): Promise<Discovery> {
  const prm = await getJson(fetchFn, `${server}/.well-known/oauth-protected-resource`, 'protected-resource metadata');
  const resource = requireAllowedUrl(prm.resource, 'protected-resource metadata resource');
  if (new URL(resource).origin !== server) {
    throw new CliError(`protected-resource metadata names resource ${resource}, which is not on ${server}`);
  }
  const servers = prm.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new CliError('protected-resource metadata lists no authorization server');
  }
  const issuer = requireAllowedUrl(servers[0], 'authorization server');
  const meta = await getJson(fetchFn, authorizationServerMetadataUrl(issuer), 'authorization-server metadata');
  if (typeof meta.issuer !== 'string' || meta.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    throw new CliError(`authorization-server metadata issuer '${clip(meta.issuer)}' does not match ${issuer}`);
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new CliError('the authorization server does not support PKCE S256');
  }
  const optional = (key: string): string | undefined =>
    meta[key] === undefined ? undefined : requireAllowedUrl(meta[key], key);
  const scopes = Array.isArray(prm.scopes_supported) ? prm.scopes_supported : meta.scopes_supported;
  const registration = optional('registration_endpoint');
  const revocation = optional('revocation_endpoint');
  return {
    issuer: meta.issuer,
    resource,
    authorization_endpoint: requireAllowedUrl(meta.authorization_endpoint, 'authorization_endpoint'),
    token_endpoint: requireAllowedUrl(meta.token_endpoint, 'token_endpoint'),
    ...(registration !== undefined ? { registration_endpoint: registration } : {}),
    ...(revocation !== undefined ? { revocation_endpoint: revocation } : {}),
    scopes_supported: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
    iss_parameter_supported: meta.authorization_response_iss_parameter_supported === true,
  };
}

/** The endpoints to keep with the credentials. */
export function endpointsOf(d: Discovery): ServerEndpoints {
  const { scopes_supported: _s, iss_parameter_supported: _i, ...endpoints } = d;
  return endpoints;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a stored registration can still be used. The server deletes a client never authorized
 * within 24 hours of registering, or not authorized for 30 days, so an older one is replaced
 * rather than sending the user to an "Unknown app" page.
 */
export function registrationUsable(client: ClientRegistration | undefined, registrationEndpoint: string, now: number): boolean {
  if (client === undefined || client.registration_endpoint !== registrationEndpoint) return false;
  if (client.last_authorized_at !== undefined) return now - client.last_authorized_at < 29 * DAY_MS;
  return now - client.registered_at < 23 * 60 * 60 * 1000;
}

export async function registerClient(fetchFn: Fetch, registrationEndpoint: string, now: number): Promise<ClientRegistration> {
  const response = await request(fetchFn, registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI_REGISTERED],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const body = await jsonBody(response);
  if (response.status !== 201 && response.status !== 200) throw oauthError('client registration', response.status, body);
  if (!isObject(body) || typeof body.client_id !== 'string' || body.client_id === '') {
    throw new CliError('client registration answered no client_id');
  }
  return { client_id: body.client_id, registration_endpoint: registrationEndpoint, registered_at: now };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizationUrl(
  d: ServerEndpoints,
  p: { clientId: string; redirectUri: string; challenge: string; state: string; scope: string },
): string {
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', p.state);
  url.searchParams.set('scope', p.scope);
  url.searchParams.set('resource', d.resource);
  return url.toString();
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;margin:3em"><h1>${title}</h1><p>${text}</p></body>`;

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once a callback with the right `state` arrives. */
  code: Promise<string>;
  close: () => void;
}

/**
 * Listens on 127.0.0.1 on an ephemeral port for the authorization response. A callback with a
 * wrong or missing `state` is answered 400 and ignored (it did not come from our request); one
 * with our `state` ends the wait with its code or its error.
 */
export async function listenForCallback(opts: {
  state: string;
  issuer: string;
  requireIss: boolean;
  timeoutMs: number;
}): Promise<LoopbackListener> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, title: string, text: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, text));
    };
    if (req.method !== 'GET' || url.pathname !== '/callback') return send(404, 'Not found', 'Nothing here.');
    const params = url.searchParams;
    const state = params.get('state');
    if (state === null || !sameSecret(state, opts.state)) {
      return send(400, 'Sign-in not recognised', 'This response does not match the sign-in in progress.');
    }
    const iss = params.get('iss');
    if ((iss !== null || opts.requireIss) && iss !== opts.issuer) {
      send(400, 'Sign-in failed', 'The response came from an unexpected issuer.');
      return settle.reject(new CliError(`authorization response issuer '${clip(iss)}' is not ${opts.issuer}`));
    }
    const error = params.get('error');
    if (error !== null) {
      send(400, 'Sign-in failed', 'You can close this tab and return to the terminal.');
      const description = params.get('error_description');
      return settle.reject(
        new CliError(`authorization failed: ${clip(error)}${description !== null ? ` (${clip(description)})` : ''}`),
      );
    }
    const received = params.get('code');
    if (received === null || received === '') {
      send(400, 'Sign-in failed', 'The response carried no code.');
      return settle.reject(new CliError('authorization response carried no code'));
    }
    send(200, 'Signed in', 'autologger-mcp is signed in. You can close this tab and return to the terminal.');
    settle.resolve(received);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(
    () => settle.reject(new CliError(`timed out after ${Math.round(opts.timeoutMs / 1000)} s waiting for the browser sign-in`)),
    opts.timeoutMs,
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  };
  code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** The token endpoint said `invalid_grant`: the refresh token or code is no longer good. */
export class InvalidGrantError extends CliError {}
/** The token endpoint does not know the client (it was swept, or the server was reset). */
export class InvalidClientError extends CliError {}

function oauthError(what: string, status: number, body: unknown): CliError {
  const error = isObject(body) && typeof body.error === 'string' ? body.error : undefined;
  const description = isObject(body)
    ? typeof body.error_description === 'string'
      ? body.error_description
      : typeof body.detail === 'string'
        ? body.detail
        : undefined
    : undefined;
  const message = `${what} failed (${status}${error !== undefined ? ` ${clip(error, 80)}` : ''})${
    description !== undefined ? `: ${clip(description)}` : ''
  }`;
  if (error === 'invalid_grant') return new InvalidGrantError(message);
  if (error === 'invalid_client') return new InvalidClientError(message);
  return new CliError(message);
}

async function tokenRequest(fetchFn: Fetch, endpoint: string, form: Record<string, string>, what: string): Promise<TokenResponse> {
  const response = await request(fetchFn, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await jsonBody(response);
  if (response.status !== 200) throw oauthError(what, response.status, body);
  if (!isObject(body) || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new CliError(`${what} answered no access_token`);
  }
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
    throw new CliError(`${what} answered token_type '${clip(body.token_type)}', not Bearer`);
  }
  return {
    access_token: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token !== '' ? { refresh_token: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number' && body.expires_in > 0 ? { expires_in: body.expires_in } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

export function exchangeCode(
  fetchFn: Fetch,
  d: ServerEndpoints,
  p: { clientId: string; code: string; redirectUri: string; verifier: string },
): Promise<TokenResponse> {
  return tokenRequest(
    fetchFn,
    d.token_endpoint,
    {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
      resource: d.resource,
    },
    'code exchange',
  );
}

/** Rotates a refresh token. No `scope` is sent, so the grant's own scope comes back. */
export function refreshGrant(fetchFn: Fetch, d: ServerEndpoints, clientId: string, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(
    fetchFn,
    d.token_endpoint,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: d.resource },
    'token refresh',
  );
}

export async function revokeToken(fetchFn: Fetch, endpoint: string, clientId: string, token: string): Promise<void> {
  const response = await request(fetchFn, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
  });
  if (response.status !== 200) throw oauthError('revocation', response.status, await jsonBody(response));
}

export function newState(): string {
  return randomBytes(24).toString('base64url');
}
