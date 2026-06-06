import { createServer } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleRawTerminalHttpRequest,
  isLoopbackAddress,
  type RawTerminalHttpService,
} from '../src/raw-terminal-http.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start(service: RawTerminalHttpService): Promise<string> {
  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    void handleRawTerminalHttpRequest({ req, res, parsedUrl, service }).then((handled) => {
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

function createService(): RawTerminalHttpService {
  return {
    readScreen: vi.fn(async () => 'raw screen'),
    readState: vi.fn(async () => ({
      cursor: { row: 3, col: 7 },
      altScreen: true,
      pasteMode: true,
      rawMode: true,
      scrollRegion: { top: 1, bot: 20 },
      cols: 100,
      rows: 30,
    })),
    writeInput: vi.fn(async () => {}),
    writeKeys: vi.fn(async () => {}),
  };
}

describe('raw terminal HTTP routes', () => {
  it('serves Phase 2 screen and state from localhost', async () => {
    const service = createService();
    const baseUrl = await start(service);

    const screen = await fetch(`${baseUrl}/api/v1/sessions/session%201/screen?format=text`);
    expect(screen.status).toBe(200);
    expect(screen.headers.get('content-type')).toContain('text/plain');
    expect(await screen.text()).toBe('raw screen');
    expect(service.readScreen).toHaveBeenCalledWith('session 1');

    const state = await fetch(`${baseUrl}/api/v1/sessions/session-1/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      cursor: { row: 3, col: 7 },
      altScreen: true,
      pasteMode: true,
      rawMode: true,
      scrollRegion: { top: 1, bot: 20 },
      cols: 100,
      rows: 30,
    });
  });

  it('writes raw text and named key arrays', async () => {
    const service = createService();
    const baseUrl = await start(service);

    const input = await fetch(`${baseUrl}/api/v1/sessions/session-1/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '/resume' }),
    });
    expect(input.status).toBe(200);
    expect(service.writeInput).toHaveBeenCalledWith('session-1', '/resume');

    const keys = await fetch(`${baseUrl}/api/v1/sessions/session-1/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['down', 'enter'] }),
    });
    expect(keys.status).toBe(200);
    expect(service.writeKeys).toHaveBeenCalledWith('session-1', ['down', 'enter']);
  });

  it('rejects non-loopback peers before terminal access', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.8')).toBe(false);
    expect(isLoopbackAddress('203.0.113.9')).toBe(false);
  });

  it('rejects deferred formats and malformed input', async () => {
    const service = createService();
    const baseUrl = await start(service);

    const ansi = await fetch(`${baseUrl}/api/v1/sessions/session-1/screen?format=ansi`);
    expect(ansi.status).toBe(400);

    const badKeys = await fetch(`${baseUrl}/api/v1/sessions/session-1/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: 'enter' }),
    });
    expect(badKeys.status).toBe(400);
  });
});
