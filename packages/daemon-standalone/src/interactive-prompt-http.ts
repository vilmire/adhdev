import type { IncomingMessage, ServerResponse } from 'http';
import type { InteractivePrompt, InteractivePromptResponse } from '@adhdev/daemon-core';
import { isLoopbackRequest } from './raw-terminal-http.js';

export interface InteractivePromptHttpService {
  getPrompt(sessionId: string): Promise<InteractivePrompt | null>;
  resolvePrompt(sessionId: string, response: InteractivePromptResponse): Promise<void>;
}

type InteractivePromptAction = 'get' | 'resolve';

function parseInteractivePromptPath(pathname: string): { sessionId: string; action: InteractivePromptAction } | null {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/interactive-prompt(?:\/(resolve))?$/.exec(pathname);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]).trim();
    if (!sessionId) return null;
    return { sessionId, action: match[2] === 'resolve' ? 'resolve' : 'get' };
  } catch {
    return null;
  }
}

export function isInteractivePromptApiPath(pathname: string): boolean {
  return parseInteractivePromptPath(pathname) !== null;
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
  if (/Request body too large|JSON|promptId|answers/i.test(message)) return 400;
  return 500;
}

function assertInteractivePromptResponse(value: Record<string, unknown>): InteractivePromptResponse {
  if (typeof value.promptId !== 'string' || !value.promptId.trim()) {
    throw new Error('promptId must be a non-empty string');
  }
  if (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) {
    throw new Error('answers must be an object');
  }
  return value as unknown as InteractivePromptResponse;
}

export async function handleInteractivePromptHttpRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedUrl: URL;
  service: InteractivePromptHttpService;
}): Promise<boolean> {
  const { req, res, parsedUrl, service } = options;
  const route = parseInteractivePromptPath(parsedUrl.pathname);
  if (!route) return false;

  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: 'Interactive prompt API is available only from localhost.' });
    return true;
  }

  const method = req.method || 'GET';
  try {
    if (route.action === 'get' && method === 'GET') {
      writeJson(res, 200, await service.getPrompt(route.sessionId));
      return true;
    }

    if (route.action === 'resolve' && method === 'POST') {
      const body = await readJsonBody(req);
      const response = assertInteractivePromptResponse(body);
      await service.resolvePrompt(route.sessionId, response);
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
