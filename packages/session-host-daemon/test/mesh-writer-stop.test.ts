import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionHostRecord, StopMeshWriterPayload } from '@adhdev/session-host-core';
import { SessionHostServer } from '../src/server.js';

const assignment = { meshId: 'mesh-writer', nodeId: 'node-worker', taskId: 'task-worker', attemptId: 'attempt-worker', generation: 1, dispatchNonce: 2, ownerDaemonId: 'daemon-owner' };
const payload: StopMeshWriterPayload = { sessionId: 'session-worker', clientId: 'client-source', providerType: 'antigravity-cli', runtimeKey: 'native-incarnation-1', startedAt: 123456, osPid: 417, assignment };

async function fixture(run: (server: any, stops: string[], record: SessionHostRecord) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-writer-stop-host-'));
  try {
    const server = new SessionHostServer({ appName: 'mesh-writer-stop-host-test', storageRootDir: dir }) as any;
    const record: SessionHostRecord = { sessionId: payload.sessionId, runtimeKey: payload.runtimeKey, displayName: 'Worker', workspaceLabel: 'test',
      transport: 'pty', providerType: payload.providerType, category: 'cli', workspace: '/fake/worktree', launchCommand: { command: 'fake-worker', args: [] },
      osPid: payload.osPid, createdAt: payload.startedAt, startedAt: payload.startedAt, lastActivityAt: payload.startedAt, lifecycle: 'running',
      writeOwner: { clientId: payload.clientId, ownerType: 'agent', acquiredAt: payload.startedAt }, attachedClients: [],
      buffer: { scrollbackBytes: 0, snapshotSeq: 0 }, meta: { meshActiveAssignment: { ...assignment } } };
    server.registry.restoreSession(record);
    const stops: string[] = [];
    // Real request handler + registry/storage; the process is entirely fake.
    // No socket, PTY, runtime process or daemon is started or controlled.
    server.runtimes.set(record.sessionId, { stop: (signal: string) => stops.push(signal) });
    await run(server, stops, record);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('exact current writer receives SIGKILL, but request acceptance never claims quiescence', async () => {
  await fixture(async (server, stops) => {
    const reply = await server.handleRequest({ type: 'stop_mesh_writer', payload });
    assert.equal(reply.success, true);
    assert.deepEqual(stops, ['SIGKILL']);
    assert.deepEqual(reply.result, { requested: true });
    assert.equal(reply.quiescent, undefined);
    assert.equal(server.registry.getSession(payload.sessionId).lifecycle, 'stopping');
  });
});
for (const [name, over] of Object.entries({ wrong_session: { sessionId: 'foreign-session' }, wrong_provider: { providerType: 'foreign-cli' },
  pid_reuse: { startedAt: payload.startedAt + 1 }, wrong_pid: { osPid: 418 }, runtime_replacement: { runtimeKey: 'new-incarnation' },
  foreign_write_holder: { clientId: 'foreign-client' }, old_attempt: { assignment: { ...assignment, attemptId: 'old-attempt' } },
  wrong_generation: { assignment: { ...assignment, generation: 0 } }, stale_nonce: { assignment: { ...assignment, dispatchNonce: 1 } },
  foreign_owner: { assignment: { ...assignment, ownerDaemonId: 'foreign-owner' } }, malformed_assignment: { assignment: {} },
})) {
  test(`native CAS refuses ${name} before touching the fake physical writer`, async () => {
    await fixture(async (server, stops) => {
      const reply = await server.handleRequest({ type: 'stop_mesh_writer', payload: { ...payload, ...over } as StopMeshWriterPayload });
      assert.equal(reply.success, false);
      assert.deepEqual(stops, []);
      assert.equal(server.registry.getSession(payload.sessionId).lifecycle, 'running');
    });
  });
}
for (const launchRecord of [{ launchedBy: 'assistant' }, { roleLaunch: { role: 'coordinator' } }]) {
  test('native host protects persisted assistant/coordinator launch provenance', async () => {
    await fixture(async (server, stops, record) => {
      server.registry.restoreSession({ ...record, meta: { ...record.meta, launchRecord } });
      const reply = await server.handleRequest({ type: 'stop_mesh_writer', payload });
      assert.equal(reply.success, false);
      assert.deepEqual(stops, []);
    });
  });
}
