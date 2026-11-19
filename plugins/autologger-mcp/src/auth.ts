// Signing in, keeping the access token fresh, and signing out.
//
// Refresh tokens rotate and the server treats a second use outside its grace window as theft
// (it revokes the grant). So every refresh runs under the credentials lock, re-reads the file
// first (another process may already have rotated), and saves the new tokens atomically before
// the new access token is used.
import { devTokenHint, loginCommand, reusableClientId } from './commands.ts';
import { CliError, NotSignedInError } from './errors.ts';
import { clip, type Fetch, isObject } from './http.ts';
import {
  authorizationUrl,
  createPkce,
  discover,
  endpointsOf,
  exchangeCode,
  InvalidClientError,
  InvalidGrantError,
  listenForCallback,
  newState,
  READ_SCOPE,
  refreshGrant,
  registerClient,
  registrationUsable,
  revokeToken,
  type TokenResponse,
  WRITE_SCOPE,
} from './oauth.ts';
import { type CredentialStore, type Credentials, rememberSecrets, type ServerEndpoints, type Tokens } from './store.ts';

/** Refresh this long before the stated expiry, so a token does not lapse in flight. */
export const EXPIRY_MARGIN_MS = 60_000;

export interface AuthContext {
  fetch: Fetch;
  now: () => number;
  store: CredentialStore;
}

/**
 * The not-signed-in error: run `login`, or, for a local dev stack (a loopback server), the
 * dev-token line, reusing the stored client when it can.
 */
export function notSignedIn(store: CredentialStore, why = 'not signed in', now = Date.now()): NotSignedInError {
  let clientId: string | undefined;
  try {
    clientId = reusableClientId(store.load(), now);
  } catch {
    // An unreadable credentials file: the hint just registers a new client.
  }
  const hint = devTokenHint(store.server, clientId);
  return new NotSignedInError(`${why} to ${store.server}; run ${loginCommand(store.server, false)} (to edit session data, run ${loginCommand(store.server, true)} instead)${hint === '' ? '' : `\n${hint}`}`);
}

function tokensFrom(response: TokenResponse, now: number, fallbackScope: string, previousRefresh?: string): Tokens {
  const refresh = response.refresh_token ?? previousRefresh;
  return {
    access_token: response.access_token,
    ...(refresh !== undefined ? { refresh_token: refresh } : {}),
    ...(response.expires_in !== undefined ? { expires_at: now + response.expires_in * 1000 } : {}),
    scope: response.scope ?? fallbackScope,
    obtained_at: now,
  };
}

export function isExpired(tokens: Tokens, now: number): boolean {
  return tokens.expires_at !== undefined && tokens.expires_at - EXPIRY_MARGIN_MS <= now;
}

export interface LoginOptions {
  write: boolean;
  timeoutMs: number;
  /** Shows the authorization URL to the user (and opens a browser when it can). */
  present: (url: string) => void;
}

export interface LoginResult {
  server: string;
  scope: string;
  expires_at?: number;
  client_id: string;
  registered: boolean;
}

export async function login(ctx: AuthContext, opts: LoginOptions): Promise<LoginResult> {
  const { store } = ctx;
  const server = store.server;
  const discovery = await discover(ctx.fetch, server);
  const endpoints = endpointsOf(discovery);
  const scope = opts.write ? `${READ_SCOPE} ${WRITE_SCOPE}` : READ_SCOPE;
  for (const s of scope.split(' ')) {
    if (discovery.scopes_supported.length > 0 && !discovery.scopes_supported.includes(s)) {
      throw new CliError(`${server} does not offer the scope '${s}'`);
    }
  }

  let creds: Credentials = { ...store.load(), endpoints };
  const registrationEndpoint = endpoints.registration_endpoint;
  if (registrationEndpoint === undefined) {
    throw new CliError(`${server} advertises no registration endpoint, so this CLI cannot register itself`);
  }

  for (let attempt = 0; ; attempt++) {
    let registered = false;
    if (!registrationUsable(creds.client, registrationEndpoint, ctx.now())) {
      creds = { ...creds, client: await registerClient(ctx.fetch, registrationEndpoint, ctx.now()) };
      store.save(creds);
      registered = true;
    }
    const client = creds.client;
    if (client === undefined) throw new CliError('client registration missing');

    const pkce = createPkce();
    const state = newState();
    const listener = await listenForCallback({
      state,
      issuer: discovery.issuer,
      requireIss: discovery.iss_parameter_supported,
      timeoutMs: opts.timeoutMs,
    });
    let response: TokenResponse;
    try {
      opts.present(
        authorizationUrl(endpoints, {
          clientId: client.client_id,
          redirectUri: listener.redirectUri,
          challenge: pkce.challenge,
          state,
          scope,
        }),
      );
      const code = await listener.code;
      response = await exchangeCode(ctx.fetch, endpoints, {
        clientId: client.client_id,
        code,
        redirectUri: listener.redirectUri,
        verifier: pkce.verifier,
      });
    } catch (error) {
      // A client the server no longer knows: register again and start over, once.
      if (error instanceof InvalidClientError && !registered && attempt === 0) {
        creds = { ...creds };
        delete creds.client;
        continue;
      }
      throw error;
    } finally {
      listener.close();
    }

    const now = ctx.now();
    const tokens = tokensFrom(response, now, scope);
    // Replacing the tokens: the old refresh token is dropped (its grant remains until it lapses or
    // is revoked under Connected apps); the new ones are what this server is used with from now.
    creds = await store.withLock(async () => {
      const latest = store.load();
      const next: Credentials = { ...latest, endpoints, client: { ...client, last_authorized_at: now }, tokens };
      store.save(next);
      return next;
    });
    return {
      server,
      scope: tokens.scope,
      ...(tokens.expires_at !== undefined ? { expires_at: tokens.expires_at } : {}),
      client_id: client.client_id,
      registered,
    };
  }
}

/** Signed-in credentials, or NotSignedInError. Reads only the local file. */
export function requireSignedIn(store: CredentialStore, now = Date.now()): Required<Pick<Credentials, 'endpoints' | 'client' | 'tokens'>> & Credentials {
  const creds = store.load();
  if (creds.tokens === undefined || creds.endpoints === undefined || creds.client === undefined) {
    throw notSignedIn(store, undefined, now);
  }
  return creds as Required<Pick<Credentials, 'endpoints' | 'client' | 'tokens'>> & Credentials;
}

/**
 * Hands out access tokens: the stored one while it is fresh, otherwise a refreshed one. After the
 * server rejects a token (401), `afterRejection` refreshes once.
 */
export class TokenSource {
  readonly ctx: AuthContext;
  readonly endpoints: ServerEndpoints;
  scope: string;
  private current: string;

  constructor(ctx: AuthContext) {
    this.ctx = ctx;
    const creds = requireSignedIn(ctx.store, ctx.now());
    this.endpoints = creds.endpoints;
    this.current = creds.tokens.access_token;
    this.scope = creds.tokens.scope;
    if (isExpired(creds.tokens, ctx.now())) this.current = '';
  }

  async token(): Promise<string> {
    if (this.current === '') this.current = await this.refresh(undefined);
    return this.current;
  }

  /** The server answered 401 to `rejected`: get a token other than it, refreshing if needed. */
  async afterRejection(rejected: string): Promise<string> {
    this.current = await this.refresh(rejected);
    return this.current;
  }

  private async refresh(rejected: string | undefined): Promise<string> {
    const { store } = this.ctx;
    return store.withLock(async () => {
      const creds = store.load();
      const tokens = creds.tokens;
      if (tokens === undefined || creds.client === undefined || creds.endpoints === undefined) {
        throw notSignedIn(store, undefined, this.ctx.now());
      }
      // A fresh token other than the rejected one: another process refreshed while we waited for
      // the lock (or before we started). Use it rather than spending the refresh token again.
      if (tokens.access_token !== rejected && !isExpired(tokens, this.ctx.now())) {
        this.scope = tokens.scope;
        return tokens.access_token;
      }
      if (tokens.refresh_token === undefined) {
        store.clearTokens();
        throw notSignedIn(store, 'the access token expired and there is no refresh token; signed out', this.ctx.now());
      }
      let response: TokenResponse;
      try {
        response = await refreshGrant(this.ctx.fetch, creds.endpoints, creds.client.client_id, tokens.refresh_token);
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          store.clearTokens();
          throw notSignedIn(store, 'the sign-in has expired or was revoked (invalid_grant); signed out', this.ctx.now());
        }
        throw error;
      }
      const next = tokensFrom(response, this.ctx.now(), tokens.scope, tokens.refresh_token);
      store.save({ ...creds, tokens: next });
      this.scope = next.scope;
      return next.access_token;
    });
  }
}

export interface LogoutResult {
  server: string;
  was_signed_in: boolean;
  revoked: boolean;
}

/**
 * Revokes the stored grant at the server (its refresh token, else its access token). Returns null
 * when it was revoked, else why not; never throws.
 */
async function revokeStored(ctx: AuthContext, creds: Credentials): Promise<string | null> {
  const tokens = creds.tokens;
  if (tokens === undefined) return null;
  const endpoint = creds.endpoints?.revocation_endpoint;
  if (endpoint === undefined || creds.client === undefined) return 'the server advertises no revocation endpoint';
  try {
    await revokeToken(ctx.fetch, endpoint, creds.client.client_id, tokens.refresh_token ?? tokens.access_token);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Revokes the grant at the server when it can, then deletes the local tokens whatever happened. */
export async function logout(ctx: AuthContext, warn: (message: string) => void): Promise<LogoutResult> {
  const { store } = ctx;
  return store.withLock(async () => {
    const creds = store.load();
    if (creds.tokens === undefined) return { server: store.server, was_signed_in: false, revoked: false };
    const why = await revokeStored(ctx, creds);
    if (why === 'the server advertises no revocation endpoint') {
      warn('the server advertises no revocation endpoint; only the local credentials were deleted');
    } else if (why !== null) {
      warn(
        `could not revoke the sign-in at the server (${why}); the local credentials were deleted anyway. You can also revoke it under Connected apps in autologger.`,
      );
    }
    store.clearTokens();
    return { server: store.server, was_signed_in: true, revoked: why === null };
  });
}

/** The scopes `import-tokens` accepts: the two this CLI's `login` asks for. */
export const IMPORT_SCOPES: readonly string[] = [READ_SCOPE, `${READ_SCOPE} ${WRITE_SCOPE}`];

/** The JSON line `make dev-mcp-token` prints (autologger-2 server/src/devMcpToken.ts), validated. */
export interface DevTokenGrant {
  issuer: string;
  resource: string;
  client_id: string;
  scope: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const GRANT_FIELDS = ['issuer', 'resource', 'client_id', 'scope', 'token_type', 'access_token', 'refresh_token', 'expires_in'] as const;
const NOT_JSON = 'standard input is not the JSON object make dev-mcp-token prints';

/** The one JSON object in `text`: the whole input, else the single line of it that is one. */
function onlyJsonObject(text: string): Record<string, unknown> {
  const parse = (t: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(t);
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = parse(text.trim());
  if (whole !== undefined) return whole;
  // Tolerate chatter around it (a make that prints "Entering directory" on stdout), but only one
  // candidate: two token lines would be ambiguous.
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  const objects = lines.map(parse).filter((o): o is Record<string, unknown> => o !== undefined);
  if (objects.length === 1 && objects[0] !== undefined) return objects[0];
  // Never JSON.parse's own message: it quotes the input, which holds tokens.
  throw new CliError(text.trim() === '' ? 'standard input is empty; pipe the output of make dev-mcp-token into import-tokens' : NOT_JSON);
}

/**
 * Parses and checks the dev-mcp-token JSON. Error messages name fields, never their values (only the
 * scope and the URLs are quoted), and any token found is remembered for redaction before anything
 * can fail.
 */
export function parseDevTokenGrant(text: string): DevTokenGrant {
  const value = onlyJsonObject(text);
  const strings: Partial<Record<(typeof GRANT_FIELDS)[number], string>> = {};
  for (const key of ['access_token', 'refresh_token'] as const) {
    const raw = value[key];
    if (typeof raw === 'string' && raw !== '') rememberSecrets({ access_token: raw, scope: '', obtained_at: 0 });
  }
  const missing = GRANT_FIELDS.filter((k) => value[k] === undefined || value[k] === null || value[k] === '');
  if (missing.length > 0) throw new CliError(`the token JSON lacks ${missing.join(', ')}`);
  for (const key of GRANT_FIELDS) {
    if (key === 'expires_in') continue;
    const raw = value[key];
    if (typeof raw !== 'string') throw new CliError(`the token JSON's ${key} is not a string`);
    strings[key] = raw;
  }
  if (strings.token_type !== 'Bearer') throw new CliError(`the token JSON's token_type is '${clip(strings.token_type, 40)}', not Bearer`);
  const scope = strings.scope ?? '';
  if (!IMPORT_SCOPES.includes(scope)) {
    throw new CliError(`the token JSON's scope '${clip(scope, 80)}' is not one this CLI understands (${IMPORT_SCOPES.map((s) => `'${s}'`).join(' or ')})`);
  }
  const expiresIn = value.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new CliError(`the token JSON's expires_in is not a positive number of seconds`);
  }
  return {
    issuer: strings.issuer ?? '',
    resource: strings.resource ?? '',
    client_id: strings.client_id ?? '',
    scope,
    access_token: strings.access_token ?? '',
    refresh_token: strings.refresh_token ?? '',
    expires_in: expiresIn,
  };
}

export interface ImportResult {
  server: string;
  scope: string;
  expires_at: number;
  client_id: string;
  /** Tokens were stored for this server before (now replaced). */
  replaced: boolean;
  /** The previous sign-in's grant was revoked at the server (false when there was none, it was the same grant, or revoking failed). */
  revoked_previous: boolean;
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/$/, '') === b.replace(/\/$/, '');

/**
 * Stores tokens minted outside the browser flow (`make dev-mcp-token`) as this server's sign-in.
 * The issuer and resource must be the server's own, from the same discovery `login` runs; nothing
 * is written until they are. A previous sign-in holding another grant is revoked first (a failed
 * revoke only warns), then replaced, under the credentials lock.
 */
export async function importTokens(ctx: AuthContext, grant: DevTokenGrant, warn: (message: string) => void): Promise<ImportResult> {
  const { store } = ctx;
  const server = store.server;
  const discovery = await discover(ctx.fetch, server);
  if (!sameUrl(grant.issuer, discovery.issuer)) {
    throw new CliError(`the token JSON's issuer '${clip(grant.issuer, 200)}' is not ${server}'s (${discovery.issuer}); nothing was stored`);
  }
  if (!sameUrl(grant.resource, discovery.resource)) {
    throw new CliError(`the token JSON's resource '${clip(grant.resource, 200)}' is not ${server}'s (${discovery.resource}); nothing was stored`);
  }
  for (const s of grant.scope.split(' ')) {
    if (discovery.scopes_supported.length > 0 && !discovery.scopes_supported.includes(s)) {
      throw new CliError(`${server} does not offer the scope '${s}'; nothing was stored`);
    }
  }
  const endpoints = endpointsOf(discovery);
  const registrationEndpoint = endpoints.registration_endpoint;
  if (registrationEndpoint === undefined) {
    throw new CliError(`${server} advertises no registration endpoint; nothing was stored`);
  }

  return store.withLock(async () => {
    const previous = store.load();
    const old = previous.tokens;
    let revoked = false;
    // The same grant when either token is the one being imported (an import run twice): revoking
    // it would revoke the tokens just imported.
    const sameGrant = old !== undefined && (old.access_token === grant.access_token || old.refresh_token === grant.refresh_token);
    if (old !== undefined && !sameGrant) {
      const why = await revokeStored(ctx, previous);
      revoked = why === null;
      if (why !== null) {
        warn(`could not revoke the previous sign-in at the server (${why}); it was replaced anyway. You can revoke it under Connected apps in autologger.`);
      }
    }
    const now = ctx.now();
    const expiresAt = now + grant.expires_in * 1000;
    store.save({
      version: 1,
      server,
      endpoints,
      client: { client_id: grant.client_id, registration_endpoint: registrationEndpoint, registered_at: now, last_authorized_at: now },
      tokens: { access_token: grant.access_token, refresh_token: grant.refresh_token, expires_at: expiresAt, scope: grant.scope, obtained_at: now },
    });
    return { server, scope: grant.scope, expires_at: expiresAt, client_id: grant.client_id, replaced: old !== undefined, revoked_previous: revoked };
  });
}
