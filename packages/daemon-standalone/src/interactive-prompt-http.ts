import type { IncomingMessage, ServerResponse } from 'http';
import type { DaemonHostRuntime, InteractivePrompt, InteractivePromptResponse } from '@adhdev/daemon-core';
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

/**
 * The router-backed service (wiring-unification B5, checklist item 4).
 *
 * Before B5 `resolvePrompt` called the instance directly, so a stale answer (a
 * promptId the session no longer holds — e.g. an old dashboard tab after a
 * daemon rebind) was silently applied or dropped. It now executes
 * `interactive_prompt_response` through the host runtime, which reaches the
 * same handler the mesh path uses: its STALE-PROMPT-ANSWER guard rejects a
 * mismatched promptId (HTTP 400 via `errorStatus`), it forwards a session this
 * daemon does not own, and the command gets the router's command log +
 * `command_executed` (fast flush of the dashboard).
 *
 * Session ids resolve through the registry's alias index (id or
 * provider-native session id); the old fuzzy scan of every instance state is
 * kept only as a last resort for an `activeChat.id` match.
 */
export function createRouterInteractivePromptService(host: DaemonHostRuntime): InteractivePromptHttpService {
  const { components } = host.runtime;
  const findState = (sessionId: string): Record<string, any> | null => {
    const resolved = components.sessionRegistry.resolveAlias(sessionId);
    const direct = resolved ? components.instanceManager.getInstance(resolved) : components.instanceManager.getInstance(sessionId);
    if (direct) {
      try { return direct.getState() as unknown as Record<string, any>; } catch { return null; }
    }
    const match = components.instanceManager.collectAllStates().find((state: any) => state?.activeChat?.id === sessionId);
    return (match as unknown as Record<string, any>) ?? null;
  };
  const resolveSessionId = (sessionId: string): string | null => {
    const resolved = components.sessionRegistry.resolveAlias(sessionId);
    if (resolved) return resolved;
    if (components.instanceManager.getInstance(sessionId)) return sessionId;
    const state = findState(sessionId);
    return typeof state?.instanceId === 'string' ? state.instanceId : null;
  };
  return {
    getPrompt: async (sessionId) => {
      const state = findState(sessionId);
      return (state?.activeInteractivePrompt || state?.activeChat?.activeInteractivePrompt || null) as InteractivePrompt | null;
    },
    resolvePrompt: async (sessionId, response) => {
      const targetSessionId = resolveSessionId(sessionId);
      if (!targetSessionId) throw new Error(`Unknown session: ${sessionId}`);
      const result = await host.execute('interactive_prompt_response', { targetSessionId, response }, 'standalone');
      if (result.success === false) {
        const error = typeof result.error === 'string' && result.error ? result.error : 'interactive prompt response failed';
        throw new Error(/No running instance/i.test(error) ? `Unknown session: ${sessionId}` : error);
      }
    },
  };
}
