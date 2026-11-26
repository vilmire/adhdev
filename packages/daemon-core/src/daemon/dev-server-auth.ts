import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config/config.js';

export const DEV_SERVER_PORT = 19280;
export const ADHDEV_DEV_SERVER_TOKEN_HEADER = 'x-adhdev-dev-token';
export const ADHDEV_DEV_SERVER_AUTH_FILE_ENV = 'ADHDEV_DEV_SERVER_AUTH_FILE';

const LOOPBACK_DEV_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeDevHostCandidate(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  if (host.startsWith('::ffff:')) host = host.slice(7);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function parseDevHostHeader(rawHostHeader: string): { hostname: string; port: string } | null {
  const trimmed = rawHostHeader.trim();
  if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return null;
    }
    const hostname = normalizeDevHostCandidate(parsed.hostname);
    if (!hostname) return null;
    return { hostname, port: parsed.port || '80' };
  } catch {
    return null;
  }
}

export function isDevServerHostAllowed(req: http.IncomingMessage): boolean {
  const rawHost = req.headers.host;
  if (rawHost === undefined) {
    return !req.httpVersion && req.headers.origin === undefined;
  }
  if (typeof rawHost !== 'string') return false;
  const parsed = parseDevHostHeader(rawHost);
  return parsed !== null && LOOPBACK_DEV_HOSTNAMES.has(parsed.hostname);
}

export function isDevServerOriginAllowed(req: http.IncomingMessage): boolean {
  if (!isDevServerHostAllowed(req)) return false;
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    if (origin.protocol !== 'http:') return false;
    const originHost = normalizeDevHostCandidate(origin.hostname || '');
    if (!originHost || !LOOPBACK_DEV_HOSTNAMES.has(originHost)) return false;
    const rawHost = typeof req.headers.host === 'string' ? req.headers.host : '';
    const parsedHost = rawHost ? parseDevHostHeader(rawHost) : null;
    if (!parsedHost) return false;
    const originPort = origin.port || '80';
    return originPort === parsedHost.port;
  } catch {
    return false;
  }
}

export function devServerAuthFilePath(configDir = getConfigDir(), port = DEV_SERVER_PORT): string {
  return path.join(configDir, 'run', `dev-server-auth-${port}`);
}

export function mintDevServerAuthToken(): string {
  return `add_${crypto.randomBytes(32).toString('base64url')}`;
}

export function writeDevServerAuthFile(filePath: string, token: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fs.renameSync(tmp, filePath);
}

export function readDevServerAuthToken(port = DEV_SERVER_PORT, configDir?: string): string | null {
  const candidates: string[] = [];
  const envFile = process.env[ADHDEV_DEV_SERVER_AUTH_FILE_ENV]?.trim();
  if (envFile) candidates.push(envFile);
  try {
    candidates.push(devServerAuthFilePath(configDir ?? getConfigDir(), port));
  } catch {
    // ignore configDir resolution errors
  }
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const token = fs.readFileSync(filePath, 'utf8').trim();
      if (token) return token;
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}

export function buildDevServerAuthHeaders(
  extraHeaders: Record<string, string | number> = {},
  port = DEV_SERVER_PORT,
  configDir?: string,
): Record<string, string | number> {
  const token = readDevServerAuthToken(port, configDir);
  return token ? { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: token, ...extraHeaders } : { ...extraHeaders };
}

export interface DirectLoopbackDevServerRequestOptions {
  path: string;
  method?: 'GET' | 'POST';
  port?: number;
  body?: unknown;
  timeoutMs?: number;
  configDir?: string;
  headers?: Record<string, string | number>;
}

export interface DirectLoopbackDevServerResponse<T = any> {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  raw: string;
  data: T;
}

/**
 * Issue a credential-bearing HTTP request directly to the local loopback
 * DevServer (127.0.0.1:<port>) using `http.request` with `agent: false`
 * (bypassing global fetch dispatchers and environment/platform proxy agents)
 * and refusing all HTTP 3xx redirects so the DevServer token is never
 * forwarded to a redirect target.
 */
export function requestDevServerLoopback<T = any>(
  options: DirectLoopbackDevServerRequestOptions,
): Promise<DirectLoopbackDevServerResponse<T>> {
  const port = options.port ?? DEV_SERVER_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error(`Invalid DevServer port: ${port}`));
  }
  const reqPath = options.path;
  if (typeof reqPath !== 'string' || !reqPath.startsWith('/') || reqPath.startsWith('//')) {
    return Promise.reject(new Error(`Invalid DevServer path: ${reqPath}`));
  }
  const method = options.method ?? 'GET';
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
  const baseHeaders: Record<string, string | number> = {
    ...(payload !== undefined
      ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        }
      : {}),
    ...(options.headers ?? {}),
  };
  const headers = buildDevServerAuthHeaders(baseHeaders, port, options.configDir);

  return new Promise<DirectLoopbackDevServerResponse<T>>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      fn();
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          finish(() => reject(new Error(`Redirects are disallowed for DevServer requests (HTTP ${status})`)));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
        });
        res.on('aborted', () => {
          finish(() => reject(new Error('DevServer response aborted before completion')));
        });
        res.on('error', (err) => {
          finish(() => reject(err));
        });
        res.on('close', () => {
          if (!res.complete) {
            finish(() => reject(new Error('DevServer response closed before completion')));
          }
        });
        res.on('end', () => {
          if (!res.complete) {
            finish(() => reject(new Error('DevServer response ended before completion')));
            return;
          }
          let data: any;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { raw };
          }
          finish(() =>
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: res.headers,
              raw,
              data: data as T,
            }),
          );
        });
      },
    );
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutError = () => new Error('DevServer request timed out');
      deadlineTimer = setTimeout(() => {
        const err = timeoutError();
        req.destroy(err);
        finish(() => reject(err));
      }, options.timeoutMs);
      req.setTimeout(options.timeoutMs, () => {
        const err = timeoutError();
        req.destroy(err);
        finish(() => reject(err));
      });
    }
    req.on('error', (err) => {
      finish(() => reject(err));
    });
    req.on('close', () => {
      if (!settled) {
        finish(() => reject(new Error('DevServer request closed before response completed')));
      }
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export function devTokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
