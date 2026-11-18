// Signing in, keeping the access token fresh, and signing out.
//
// Refresh tokens rotate and the server treats a second use outside its grace window as theft
// (it revokes the grant). So every refresh runs under the credentials lock, re-reads the file
// first (another process may already have rotated), and saves the new tokens atomically before
// the new access token is used.
import { CliError, NotSignedInError } from './errors.ts';
import type { Fetch } from './http.ts';
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
import type { CredentialStore, Credentials, ServerEndpoints, Tokens } from './store.ts';

/** Refresh this long before the stated expiry, so a token does not lapse in flight. */
export const EXPIRY_MARGIN_MS = 60_000;

export interface AuthContext {
  fetch: Fetch;
  now: () => number;
  store: CredentialStore;
}

export function notSignedIn(server: string, why = 'not signed in'): NotSignedInError {
  return new NotSignedInError(`${why} to ${server}; run 'autologger-mcp login' (add --write to edit session data)`);
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
export function requireSignedIn(store: CredentialStore): Required<Pick<Credentials, 'endpoints' | 'client' | 'tokens'>> & Credentials {
  const creds = store.load();
  if (creds.tokens === undefined || creds.endpoints === undefined || creds.client === undefined) {
    throw notSignedIn(store.server);
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
    const creds = requireSignedIn(ctx.store);
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
        throw notSignedIn(store.server);
      }
      // A fresh token other than the rejected one: another process refreshed while we waited for
      // the lock (or before we started). Use it rather than spending the refresh token again.
      if (tokens.access_token !== rejected && !isExpired(tokens, this.ctx.now())) {
        this.scope = tokens.scope;
        return tokens.access_token;
      }
      if (tokens.refresh_token === undefined) {
        store.clearTokens();
        throw notSignedIn(store.server, 'the access token expired and there is no refresh token; signed out');
      }
      let response: TokenResponse;
      try {
        response = await refreshGrant(this.ctx.fetch, creds.endpoints, creds.client.client_id, tokens.refresh_token);
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          store.clearTokens();
          throw notSignedIn(store.server, 'the sign-in has expired or was revoked (invalid_grant); signed out');
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

/** Revokes the grant at the server when it can, then deletes the local tokens whatever happened. */
export async function logout(ctx: AuthContext, warn: (message: string) => void): Promise<LogoutResult> {
  const { store } = ctx;
  return store.withLock(async () => {
    const creds = store.load();
    const tokens = creds.tokens;
    if (tokens === undefined) return { server: store.server, was_signed_in: false, revoked: false };
    let revoked = false;
    const endpoint = creds.endpoints?.revocation_endpoint;
    const token = tokens.refresh_token ?? tokens.access_token;
    if (endpoint === undefined || creds.client === undefined) {
      warn('the server advertises no revocation endpoint; only the local credentials were deleted');
    } else {
      try {
        await revokeToken(ctx.fetch, endpoint, creds.client.client_id, token);
        revoked = true;
      } catch (error) {
        warn(
          `could not revoke the sign-in at the server (${(error as Error).message}); the local credentials were deleted anyway. You can also revoke it under Connected apps in autologger.`,
        );
      }
    }
    store.clearTokens();
    return { server: store.server, was_signed_in: true, revoked };
  });
}
