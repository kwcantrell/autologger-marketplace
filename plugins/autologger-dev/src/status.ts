// status: whether the dev server answers, publishes its OAuth protected-resource metadata, and has
// an /mcp endpoint. Three unauthenticated requests; TLS verification stays on, and a trust failure
// is reported with the fix (the dev CA in NODE_EXTRA_CA_CERTS).
import { allowedUrl, type Fetch, isObject, jsonBody, probe } from './http.ts';

export interface StatusReport {
  server: string;
  answers: boolean;
  http_status: number | null;
  /** 'untrusted' when the TLS certificate is not trusted; null for http:// or when it never got that far. */
  tls: 'trusted' | 'untrusted' | null;
  protected_resource: { ok: boolean; resource: string | null; detail: string };
  mcp: { exists: boolean; http_status: number | null; detail: string };
  error: string | null;
  fix: string | null;
}

export const PRM_PATH = '/.well-known/oauth-protected-resource';

const TLS_FIX =
  'run autologger-dev ca to write the dev CA, export NODE_EXTRA_CA_CERTS=<that file> where Claude Code starts, and restart it (TLS verification is never turned off)';

export async function status(fetchFn: Fetch, server: string): Promise<StatusReport> {
  const https = server.startsWith('https:');
  const report: StatusReport = {
    server,
    answers: false,
    http_status: null,
    tls: null,
    protected_resource: { ok: false, resource: null, detail: 'not checked: the server did not answer' },
    mcp: { exists: false, http_status: null, detail: 'not checked: the server did not answer' },
    error: null,
    fix: null,
  };

  const root = await probe(fetchFn, `${server}/`);
  if (!root.ok) {
    report.error = root.message;
    if (root.kind === 'tls') {
      report.tls = 'untrusted';
      report.fix = TLS_FIX;
    } else {
      report.fix = 'bring the stack up: autologger-dev up (DEV_HTTPS=1 make dev-up in the checkout)';
    }
    return report;
  }
  await root.response.body?.cancel();
  report.answers = true;
  report.http_status = root.response.status;
  if (https) report.tls = 'trusted';

  const prm = await probe(fetchFn, `${server}${PRM_PATH}`, { headers: { accept: 'application/json' } });
  if (!prm.ok) {
    report.protected_resource.detail = prm.message;
  } else if (prm.response.status !== 200) {
    await prm.response.body?.cancel();
    report.protected_resource.detail = `${PRM_PATH} answered HTTP ${prm.response.status} (is CUSTOM_DASHBOARDS_ENABLED=1 and the stack in HTTPS mode?)`;
  } else {
    const body = await jsonBody(prm.response);
    const resource = isObject(body) ? body.resource : undefined;
    if (typeof resource !== 'string' || allowedUrl(resource) === null) {
      report.protected_resource.detail = `${PRM_PATH} did not return JSON naming a resource URL`;
    } else {
      report.protected_resource = { ok: true, resource, detail: `names the resource ${resource}` };
    }
  }

  // An unauthenticated MCP request: 401 (or any answer but 404) means the endpoint is there.
  const mcp = await probe(fetchFn, `${server}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  if (!mcp.ok) {
    report.mcp.detail = mcp.message;
  } else {
    await mcp.response.body?.cancel();
    const code = mcp.response.status;
    report.mcp = {
      exists: code !== 404,
      http_status: code,
      detail:
        code === 404
          ? '/mcp answered 404: the MCP endpoint is off (CUSTOM_DASHBOARDS_ENABLED=1 and DEV_HTTPS=1 are needed)'
          : code === 401
            ? '/mcp exists and asks for sign-in (401)'
            : `/mcp exists (HTTP ${code})`,
    };
  }
  if (!report.protected_resource.ok || !report.mcp.exists) {
    report.fix = 'run autologger-dev up (it sets CUSTOM_DASHBOARDS_ENABLED=1 and starts in HTTPS mode)';
  }
  return report;
}

export function formatStatus(r: StatusReport): string {
  const lines = [`Server: ${r.server}`];
  if (!r.answers) {
    lines.push(`Not answering: ${r.error ?? 'unknown error'}`);
  } else {
    lines.push(`Answers: HTTP ${String(r.http_status)}${r.tls === 'trusted' ? ' (TLS certificate trusted)' : ''}`);
    lines.push(`Protected-resource metadata: ${r.protected_resource.ok ? 'OK, ' : ''}${r.protected_resource.detail}`);
    lines.push(`MCP endpoint: ${r.mcp.detail}`);
  }
  if (r.fix !== null) lines.push(`Fix: ${r.fix}`);
  return `${lines.join('\n')}\n`;
}
