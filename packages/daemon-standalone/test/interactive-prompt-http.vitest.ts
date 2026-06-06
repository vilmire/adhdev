import { createServer } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleInteractivePromptHttpRequest,
  type InteractivePromptHttpService,
} from '../src/interactive-prompt-http.js';
import { isLoopbackAddress } from '../src/raw-terminal-http.js';
import type { InteractivePrompt } from '@adhdev/daemon-core';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start(service: InteractivePromptHttpService): Promise<string> {
  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    void handleInteractivePromptHttpRequest({ req, res, parsedUrl, service }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function createService(): InteractivePromptHttpService {
  const prompt: InteractivePrompt = {
    promptId: 'prompt-1',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 123,
    questions: [{
      questionId: 'q1',
      question: 'Pick one',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B', description: 'Bee' }],
    }],
  };
  return {
    getPrompt: vi.fn(async () => prompt),
    resolvePrompt: vi.fn(async () => {}),
  };
}

describe('interactive prompt HTTP routes', () => {
  it('round-trips current prompt and resolve response', async () => {
    const service = createService();
    const baseUrl = await start(service);

    const promptRes = await fetch(`${baseUrl}/api/v1/sessions/session%201/interactive-prompt`);
    expect(promptRes.status).toBe(200);
    expect(await promptRes.json()).toMatchObject({
      promptId: 'prompt-1',
      questions: [{ questionId: 'q1' }],
    });
    expect(service.getPrompt).toHaveBeenCalledWith('session 1');

    const resolveRes = await fetch(`${baseUrl}/api/v1/sessions/session-1/interactive-prompt/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promptId: 'prompt-1',
        answers: { q1: { selectedLabels: ['A'] } },
      }),
    });
    expect(resolveRes.status).toBe(200);
    expect(service.resolvePrompt).toHaveBeenCalledWith('session-1', {
      promptId: 'prompt-1',
      answers: { q1: { selectedLabels: ['A'] } },
    });
  });

  it('rejects malformed resolve bodies before service resolve', async () => {
    const service = createService();
    const baseUrl = await start(service);

    const resolveRes = await fetch(`${baseUrl}/api/v1/sessions/session-1/interactive-prompt/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    });
    expect(resolveRes.status).toBe(400);
    expect(service.resolvePrompt).not.toHaveBeenCalled();
  });

  it('uses the localhost-only guard shared with raw terminal routes', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.8')).toBe(false);
    expect(isLoopbackAddress('203.0.113.9')).toBe(false);
  });
});
