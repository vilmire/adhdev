import type { IncomingMessage, ServerResponse } from 'http';
import type { NamedKey } from '@adhdev/daemon-core';

export interface RawTerminalState {
  cursor: { row: number; col: number };
  altScreen: boolean;
  pasteMode: boolean;
  rawMode: boolean;
  scrollRegion: { top: number; bot: number };
  cols: number;
  rows: number;
}

export interface RawTerminalHttpService {
  readScreen(sessionId: string): Promise<string>;
  readState(sessionId: string): Promise<RawTerminalState>;
  writeInput(sessionId: string, text: string): Promise<void>;
  writeKeys(sessionId: string, keys: readonly NamedKey[]): Promise<void>;
}

type RawTerminalAction = 'screen' | 'state' | 'input' | 'keys';

function parseRawTerminalPath(pathname: string): { sessionId: string; action: RawTerminalAction } | null {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/(screen|state|input|keys)$/.exec(pathname);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]).trim();
    return sessionId ? { sessionId, action: match[2] as RawTerminalAction } : null;
  } catch {
    return null;
  }
}

export function isRawTerminalApiPath(pathname: string): boolean {
  return parseRawTerminalPath(pathname) !== null;
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  return normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized.startsWith('::ffff:127.');
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown session/i.test(message)) return 404;
  if (/not running|unavailable/i.test(message)) return 409;
  if (/Unsupported named key|keys must|text must|JSON|body too large/i.test(message)) return 400;
  return 500;
}

export async function handleRawTerminalHttpRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedUrl: URL;
  service: RawTerminalHttpService;
}): Promise<boolean> {
  const { req, res, parsedUrl, service } = options;
  const route = parseRawTerminalPath(parsedUrl.pathname);
  if (!route) return false;

  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: 'Raw terminal API is available only from localhost.' });
    return true;
  }

  const method = req.method || 'GET';
  try {
    if (route.action === 'screen' && method === 'GET') {
      const format = parsedUrl.searchParams.get('format') || 'text';
      if (format !== 'text') {
        writeJson(res, 400, { error: 'Phase 2 supports only format=text.' });
        return true;
      }
      const text = await service.readScreen(route.sessionId);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return true;
    }

    if (route.action === 'state' && method === 'GET') {
      writeJson(res, 200, await service.readState(route.sessionId));
      return true;
    }

    if (route.action === 'input' && method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string') throw new Error('text must be a string');
      await service.writeInput(route.sessionId, body.text);
      writeJson(res, 200, { success: true });
      return true;
    }

    if (route.action === 'keys' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.keys) || !body.keys.every(key => typeof key === 'string')) {
        throw new Error('keys must be an array of named key strings');
      }
      await service.writeKeys(route.sessionId, body.keys as NamedKey[]);
      writeJson(res, 200, { success: true });
      return true;
    }

    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, errorStatus(error), { error: message });
    return true;
  }
}
