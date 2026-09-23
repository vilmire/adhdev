/**
 * Interactive-prompt HTTP → router (wiring-unification B5, checklist item 4).
 *
 * `resolvePrompt` used to call the provider instance directly, so an answer
 * naming a promptId the session no longer holds (an old dashboard tab after a
 * daemon rebind) was applied or dropped silently. It now executes
 * `interactive_prompt_response` through the host runtime, reaching the REAL
 * high-family handler and its STALE-PROMPT-ANSWER guard. This drives the actual
 * handler (not a stub) behind the HTTP route.
 */
import { createServer } from 'http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-prompt-router-'));

let http: typeof import('../src/interactive-prompt-http.js');
let meshEventsHandlers: typeof import('../../daemon-core/src/commands/high-family/mesh-events.js').meshEventsHandlers;

beforeAll(async () => {
  http = await import('../src/interactive-prompt-http.js');
  ({ meshEventsHandlers } = await import('../../daemon-core/src/commands/high-family/mesh-events.js'));
});

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** A host runtime whose `execute` runs the real handler against one fake session. */
function fakeHost(heldPromptId: string) {
  const applied: unknown[] = [];
  const instance = {
    getState: () => ({ instanceId: 'sess-1', activeInteractivePrompt: { promptId: heldPromptId, questions: [] } }),
    applyInteractivePromptResponse: vi.fn(async (payload: any) => {
      applied.push(payload);
      return { promptId: payload.promptId, answers: payload.answers };
    }),
  };
  const executed: Array<{ cmd: string; args: any; source: string }> = [];
  const instanceManager = {
    getInstance: (id: string) => (id === 'sess-1' ? instance : undefined),
    collectAllStates: () => [instance.getState()],
    sendEvent: vi.fn(),
  };
  const host = {
    runtime: {
      components: {
        instanceManager,
        // `provider-sid-1` is the provider-native id of sess-1 (the alias index).
        sessionRegistry: { resolveAlias: (id: string) => (id === 'sess-1' || id === 'provider-sid-1' ? 'sess-1' : null) },
      },
    },
    execute: async (cmd: string, args: any, source: string) => {
      executed.push({ cmd, args, source });
      const result = await meshEventsHandlers[cmd]({ deps: { instanceManager } } as any, args);
      return { ...result, interactionId: 'itx' };
    },
  };
  return { host: host as any, applied, executed };
}

async function start(service: any): Promise<string> {
  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    void http.handleInteractivePromptHttpRequest({ req, res, parsedUrl, service });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function resolveAnswer(baseUrl: string, sessionId: string, promptId: string) {
  return fetch(`${baseUrl}/api/v1/sessions/${sessionId}/interactive-prompt/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ promptId, answers: { q1: { selectedLabels: ['A'] } } }),
  });
}

describe('interactive prompt HTTP → router', () => {
  it('rejects a stale promptId through the router guard (400), applying nothing', async () => {
    const { host, applied, executed } = fakeHost('prompt-new');
    const baseUrl = await start(http.createRouterInteractivePromptService(host));

    const res = await resolveAnswer(baseUrl, 'sess-1', 'prompt-old');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/Stale promptId "prompt-old"/);
    expect(applied).toEqual([]);
    expect(executed).toEqual([{ cmd: 'interactive_prompt_response', args: expect.objectContaining({ targetSessionId: 'sess-1' }), source: 'standalone' }]);
  });

  it('applies the current prompt answer, resolving the session through its provider-native alias', async () => {
    const { host, applied } = fakeHost('prompt-new');
    const baseUrl = await start(http.createRouterInteractivePromptService(host));

    const res = await resolveAnswer(baseUrl, 'provider-sid-1', 'prompt-new');
    expect(res.status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ promptId: 'prompt-new' });
  });

  it('answers 404 for an unknown session', async () => {
    const { host } = fakeHost('prompt-new');
    const baseUrl = await start(http.createRouterInteractivePromptService(host));
    const res = await resolveAnswer(baseUrl, 'nope', 'prompt-new');
    expect(res.status).toBe(404);
  });
});
