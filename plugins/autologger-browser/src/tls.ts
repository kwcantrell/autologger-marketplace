// One HTTPS request to a dev origin, verified against the dev CA alone (never with verification off).
import { request } from 'node:https';

export type ProbeResult = { ok: true; status: number } | { ok: false; code: string; message: string };

/** HEAD <origin>/ trusting only `ca`. */
export type Probe = (origin: string, ca: string) => Promise<ProbeResult>;

export const httpsProbe: Probe = (origin, ca) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (result: ProbeResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const req = request(new URL('/', origin), { method: 'HEAD', ca, rejectUnauthorized: true, agent: false, timeout: 5000 }, (res) => {
      res.resume();
      done({ ok: true, status: res.statusCode ?? 0 });
      req.destroy();
    });
    req.on('timeout', () => {
      done({ ok: false, code: 'ETIMEDOUT', message: 'no answer within 5 s' });
      req.destroy();
    });
    req.on('error', (error: NodeJS.ErrnoException) => done({ ok: false, code: error.code ?? 'error', message: error.message }));
    req.end();
  });

/** TLS verification errors (as opposed to the server not answering). */
export function isTlsError(code: string): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|HOSTNAME|ALTNAME/.test(code);
}
