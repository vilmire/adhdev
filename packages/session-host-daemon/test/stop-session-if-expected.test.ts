import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('diagnostics.hostBootId matches stop_session_if_expected non-upgrade identity', async () => {
  await fixture(async (server, _stops, _record, expected, bootId) => {
    const diagnostics = await server.handleRequest({ type: 'get_host_diagnostics', payload: {} });
    assert.equal(diagnostics.success, true);
    assert.equal(diagnostics.result.hostBootId, bootId);
    assert.equal(diagnostics.result.hostBootId, expected.hostBootId);
  });
});

test('upgradeBinding hostBootId is lease UUID and refuses hs: inventory identity', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-expected-upgrade-')));
  try {
    const helper = join(root, 'lock-helper');
    const lockSrc = join(dirname(fileURLToPath(import.meta.url)), '../native/instance-lock.c');
    if (!existsSync(lockSrc)) return;
    execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', lockSrc, '-o', helper]);
    const pin = createHash('sha256').update(readFileSync(helper)).digest('hex');
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const storageRootDir = join(stateDir, 'records');
    mkdirSync(storageRootDir, { recursive: true, mode: 0o700 });
    const server = new SessionHostServer({
      endpoint: { kind: 'unix', path: join(root, 'host.sock') },
      storageRootDir,
      upgradeBinding: { helperPath: helper, helperSha256: pin, stateDir },
    }) as any;
    await server.upgradeLease.start();
    try {
      const startedAt = 1_700_000_000_000;
      const record: SessionHostRecord = {
        sessionId: 'session-upgrade', runtimeKey: 'native-incarnation-1', displayName: 'Worker', workspaceLabel: 'test',
        transport: 'pty', providerType: 'codex-cli', category: 'cli', workspace: '/fake/worktree',
        launchCommand: { command: 'fake-worker', args: [] }, osPid: 417, createdAt: startedAt, startedAt,
        lastActivityAt: startedAt, lifecycle: 'running', writeOwner: null, attachedClients: [],
        buffer: { scrollbackBytes: 0, snapshotSeq: 0 }, meta: { meshNodeFor: 'mesh-1', launchedByCoordinator: true },
      };
      server.registry.restoreSession(record);
      const stops: string[] = [];
      server.runtimes.set(record.sessionId, { stop: () => stops.push('stop') });
      const bootId = server.upgradeLease.bootId as string;
      const diagnostics = await server.handleRequest({ type: 'get_host_diagnostics', payload: {} });
      assert.equal(diagnostics.result.hostBootId, bootId);
      assert.notEqual(bootId, hostBootIdFromStartedAt(server.startedAt));
      const hsRefuse = await server.handleRequest({
        type: 'stop_session_if_expected',
        payload: {
          sessionId: record.sessionId,
          expected: {
            sessionId: record.sessionId,
            hostBootId: hostBootIdFromStartedAt(server.startedAt),
            runtimeKey: record.runtimeKey,
            startedAt: record.startedAt!,
            taskId: null, attemptId: null, generation: null, dispatchNonce: null,
          },
        },
      });
      assert.equal(hsRefuse.success, false);
      assert.equal(hsRefuse.error, 'cleanup_host_boot_mismatch');
      assert.deepEqual(stops, []);
      const matched = await server.handleRequest({
        type: 'stop_session_if_expected',
        payload: {
          sessionId: record.sessionId,
          expected: {
            sessionId: record.sessionId, hostBootId: bootId, runtimeKey: record.runtimeKey, startedAt: record.startedAt!,
            taskId: null, attemptId: null, generation: null, dispatchNonce: null,
          },
        },
      });
      assert.equal(matched.success, true);
      assert.deepEqual(stops, ['stop']);
    } finally {
      await server.upgradeLease.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delete_session_if_expected removes the matching stopped incarnation', async () => {
  await fixture(async (server, stops, record, expected) => {
    const stop = await server.handleRequest({ type: 'stop_session_if_expected', payload: { sessionId: expected.sessionId, expected } });
    assert.equal(stop.success, true);
    assert.deepEqual(stops, ['stop']);
    server.runtimes.delete(record.sessionId);
    server.registry.setLifecycle(record.sessionId, 'stopped');
    const del = await server.handleRequest({
      type: 'delete_session_if_expected',
      payload: { sessionId: expected.sessionId, expected, force: false },
    });
    assert.equal(del.success, true);
    assert.equal(del.result.deleted, true);
    assert.equal(server.registry.getSession(expected.sessionId), null);
  });
});

test('delete_session_if_expected refuses replaced incarnation after stop await', async () => {
  await fixture(async (server, stops, record, expected) => {
    server.runtimes.set(record.sessionId, {
      stop: () => {
        stops.push('stop');
        // During await, replace the record with a new incarnation (same sessionId).
        server.runtimes.delete(record.sessionId);
        const replaced = {
          ...record,
          runtimeKey: 'native-incarnation-2',
          startedAt: record.startedAt! + 1,
          lifecycle: 'running',
          meta: {
            ...record.meta,
            meshActiveAssignment: {
              meshId: 'mesh-1', nodeId: 'n1', taskId: 'new-task', attemptId: 'a1', generation: 0, dispatchNonce: 1, ownerDaemonId: 'owner',
            },
          },
        };
        server.registry.restoreSession(replaced);
        server.runtimes.set(record.sessionId, { stop: () => stops.push('stop-replaced') });
      },
    });
    // Patch waitForRuntimeExit to resolve immediately after stop mutates.
    server.waitForRuntimeExit = async () => {};
    const del = await server.handleRequest({
      type: 'delete_session_if_expected',
      payload: { sessionId: expected.sessionId, expected, force: true },
    });
    assert.equal(del.success, false);
    assert.equal(del.error, 'cleanup_native_incarnation_mismatch');
    assert.equal(server.registry.getSession(expected.sessionId).runtimeKey, 'native-incarnation-2');
    assert.deepEqual(stops, ['stop']);
  });
});

test('delete_session_if_expected unbound refuses after bind without deleting', async () => {
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
    const del = await server.handleRequest({
      type: 'delete_session_if_expected',
      payload: { sessionId: expected.sessionId, expected, force: true },
    });
    assert.equal(del.success, false);
    assert.equal(del.error, 'cleanup_expected_unbound_now_bound');
    assert.deepEqual(stops, []);
    assert.ok(server.registry.getSession(expected.sessionId));
  });
});
