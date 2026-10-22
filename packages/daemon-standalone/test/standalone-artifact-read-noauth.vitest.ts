/**
 * Artifact "View full" on an UNAUTHENTICATED standalone (no --token, no password).
 *
 * Live repro (2026-10-23, isolated standalone): the dashboard's `artifact_fetch`
 * (and the chip's `artifact_list`) came back `COMMAND_SOURCE_REJECTED: Artifact
 * command rejected: downgraded unverified owner ingress`, because owner
 * authority requires a configured credential, so a no-auth daemon demoted every
 * dashboard command to an unverified `ipc` source and the artifact read verbs
 * refuse that source. Every other read endpoint on a no-auth daemon serves the
 * open dashboard, so the read verbs get the same treatment — and ONLY the read
 * verbs: `artifact_register` (a write) and every other command keep the
 * unverified `ipc` source, and a gated daemon is unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-artifact-noauth-'));

let mod: typeof import('../src/standalone-http.js');
let core: typeof import('@adhdev/daemon-core');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
  core = await import('@adhdev/daemon-core');
});

const TOKEN = 'dashboard-token';
const INTERNAL = 'adi_internal_token_for_test';
const INTERNAL_HEADER = 'x-adhdev-internal-auth';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

interface Call { type: string; payload: Record<string, unknown>; source: string; opts: any }

async function startServer(opts: { token?: string } = {}): Promise<{ base: string; calls: Call[]; http: InstanceType<typeof mod.StandaloneHttpApi> }> {
  const calls: Call[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({}) as any,
    executeCommand: async (type: string, payload: any, source: any, o: any) => {
      calls.push({ type, payload, source, opts: o });
      return { success: true };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  if (opts.token) http.configureAuth(opts.token);
  http.internalAuthToken = INTERNAL;
  const server = createServer((req, res) => http.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, calls, http };
}

function post(base: string, type: string, headers: Record<string, string> = {}, payload: Record<string, unknown> = { sessionId: 's1', artifactId: 'art_1' }) {
  return fetch(`${base}/api/v1/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type, payload }),
  });
}

describe('no-auth standalone — artifact read verbs', () => {
  it.each(['artifact_fetch', 'artifact_read', 'session_artifact_fetch', 'artifact_list', 'session_artifact_list'])(
    '%s reaches the router as a verified standalone owner read',
    async (verb) => {
      const { base, calls } = await startServer();
      expect((await post(base, verb)).status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe('standalone');
      expect(calls[0].opts.ownerVerified).toBe(true);
      expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).not.toBeNull();
    },
  );

  it('artifact_register (a write) keeps the unverified ipc source', async () => {
    const { base, calls } = await startServer();
    await post(base, 'artifact_register', {}, { sessionId: 's1', path: 'a.md' });
    expect(calls[0].source).toBe('ipc');
    expect(calls[0].opts.ownerVerified).toBe(false);
    expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).toBeNull();
  });

  it('other commands are not promoted', async () => {
    const { base, calls } = await startServer();
    await post(base, 'launch_cli', {}, {});
    expect(calls[0].source).toBe('ipc');
    expect(calls[0].opts.ownerVerified).toBe(false);
  });

  it('a coordinator-scope credential is not promoted to owner', async () => {
    const { base, calls } = await startServer();
    await post(base, 'artifact_fetch', { [INTERNAL_HEADER]: INTERNAL });
    expect(calls[0].source).toBe('ipc');
    expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).toBeNull();
  });

  it('a cross-origin browser request is still refused before any command runs', async () => {
    const { base, calls } = await startServer();
    const res = await post(base, 'artifact_fetch', { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a gated daemon is unchanged: no credential is 401, the token is a real owner', async () => {
    const { base, calls } = await startServer({ token: TOKEN });
    expect((await post(base, 'artifact_fetch')).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await post(base, 'artifact_fetch', { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(calls[0].source).toBe('standalone');
  });

  it('the no-auth read grant is revoked the moment auth is configured', async () => {
    const { http } = await startServer();
    const req: any = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/ws' };
    const guard = http.captureUnauthenticatedArtifactReadGuard(req, 'artifact_fetch');
    expect(guard && guard()).toBe(true);
    http.configureAuth(TOKEN);
    expect(guard && guard()).toBe(false);
  });
});
