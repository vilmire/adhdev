import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionCleanupExpectedAssignment, SessionHostRecord } from '@adhdev/session-host-core';
import { hostBootIdFromStartedAt } from '@adhdev/session-host-core';
import { SessionHostServer } from '../src/server.js';

async function fixture(run: (server: any, stops: string[], record: SessionHostRecord, expected: SessionCleanupExpectedAssignment, bootId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-expected-stop-'));
  try {
    const server = new SessionHostServer({ appName: 'cleanup-expected-stop-test', storageRootDir: dir }) as any;
    const bootId = hostBootIdFromStartedAt((server as any).startedAt);
    const startedAt = 1_700_000_000_000;
    const record: SessionHostRecord = {
      sessionId: 'session-idle', runtimeKey: 'native-incarnation-1', displayName: 'Worker', workspaceLabel: 'test',
      transport: 'pty', providerType: 'codex-cli', category: 'cli', workspace: '/fake/worktree',
      launchCommand: { command: 'fake-worker', args: [] }, osPid: 417, createdAt: startedAt, startedAt,
      lastActivityAt: startedAt, lifecycle: 'running', writeOwner: null, attachedClients: [],
      buffer: { scrollbackBytes: 0, snapshotSeq: 0 }, meta: { meshNodeFor: 'mesh-1', launchedByCoordinator: true },
    };
    server.registry.restoreSession(record);
    const stops: string[] = [];
    server.runtimes.set(record.sessionId, { stop: () => stops.push('stop') });
    const expected: SessionCleanupExpectedAssignment = {
      sessionId: record.sessionId, hostBootId: bootId, runtimeKey: record.runtimeKey, startedAt: record.startedAt!,
      taskId: null, attemptId: null, generation: null, dispatchNonce: null,
    };
    await run(server, stops, record, expected, bootId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('unbound expected stop succeeds when assignment remains none', async () => {
  await fixture(async (server, stops, _record, expected) => {
    const reply = await server.handleRequest({ type: 'stop_session_if_expected', payload: { sessionId: expected.sessionId, expected } });
    assert.equal(reply.success, true);
    assert.deepEqual(stops, ['stop']);
    assert.equal(server.registry.getSession(expected.sessionId).lifecycle, 'stopping');
  });
});

test('unbound expected refuses after a new assignment without stopping', async () => {
  await fixture(async (server, stops, record, expected) => {
    server.registry.restoreSession({
      ...record,
      meta: {
        ...record.meta,
        meshActiveAssignment: {
          meshId: 'mesh-1', nodeId: 'n1', taskId: 'new-task', attemptId: 'a1', generation: 0, dispatchNonce: 1, ownerDaemonId: 'owner',
        },
      },
    });
    const reply = await server.handleRequest({ type: 'stop_session_if_expected', payload: { sessionId: expected.sessionId, expected } });
    assert.equal(reply.success, false);
    assert.equal(reply.error, 'cleanup_expected_unbound_now_bound');
    assert.deepEqual(stops, []);
    assert.equal(server.registry.getSession(expected.sessionId).lifecycle, 'running');
  });
});

test('native incarnation mismatch refuses before touching the runtime', async () => {
  await fixture(async (server, stops, _record, expected) => {
    const reply = await server.handleRequest({
      type: 'stop_session_if_expected',
      payload: { sessionId: expected.sessionId, expected: { ...expected, runtimeKey: 'other-incarnation' } },
    });
    assert.equal(reply.success, false);
    assert.equal(reply.error, 'cleanup_native_incarnation_mismatch');
    assert.deepEqual(stops, []);
  });
});

test('host boot mismatch refuses before touching the runtime', async () => {
  await fixture(async (server, stops, _record, expected) => {
    const reply = await server.handleRequest({
      type: 'stop_session_if_expected',
      payload: { sessionId: expected.sessionId, expected: { ...expected, hostBootId: 'hs:1' } },
    });
    assert.equal(reply.success, false);
    assert.equal(reply.error, 'cleanup_host_boot_mismatch');
    assert.deepEqual(stops, []);
  });
});
