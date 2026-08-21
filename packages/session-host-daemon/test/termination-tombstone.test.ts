import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionHostServer } from '../src/server.js';
import { SessionHostStorage } from '../src/storage.js';
import type { SessionHostEvent, SessionHostLogEntry, SessionHostRecord, SessionTermination } from '@adhdev/session-host-core';

// Storage isolation: SessionHostStorage's default root is
// <instanceConfigDir>/session-host/<appName> — the REAL ~/.adhdev tree — and
// these tests persist runtimes/tombstones on every run (the first four below
// leak tombstone files permanently; they have no cleanup at all). Every
// server/storage below is rooted in this per-test tmp dir instead.
let testStorageRoot = '';
beforeEach(() => {
  testStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-term-tombstone-'));
});
afterEach(() => {
  fs.rmSync(testStorageRoot, { recursive: true, force: true });
});

function buildRecord(overrides: Partial<SessionHostRecord>): SessionHostRecord {
  const now = Date.now();
  return {
    sessionId: overrides.sessionId || `session-${Math.random()}`,
    runtimeKey: overrides.runtimeKey || 'runtime-key',
    displayName: overrides.displayName || 'Runtime',
    workspaceLabel: overrides.workspaceLabel || 'workspace',
    transport: 'pty',
    providerType: overrides.providerType || 'codex-cli',
    category: overrides.category || 'cli',
    workspace: overrides.workspace || '/tmp/workspace',
    launchCommand: overrides.launchCommand || { command: '/bin/sh', args: ['-lc', 'echo hi'] },
    createdAt: overrides.createdAt || now,
    startedAt: overrides.startedAt,
    lastActivityAt: overrides.lastActivityAt || now,
    lifecycle: overrides.lifecycle || 'running',
    writeOwner: overrides.writeOwner || null,
    attachedClients: overrides.attachedClients || [],
    buffer: overrides.buffer || { scrollbackBytes: 0, snapshotSeq: 0 },
    meta: overrides.meta || {},
    osPid: overrides.osPid,
  };
}

function collectEvents(server: any): SessionHostEvent[] {
  const events: SessionHostEvent[] = [];
  const original = server.emitEvent.bind(server);
  server.emitEvent = (event: SessionHostEvent) => {
    events.push(event);
    return original(event);
  };
  return events;
}

test('runtime exit records exactly one termination diagnostic and stamps the tombstone', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-term-once', storageRootDir: testStorageRoot }) as any;
  const record = buildRecord({ sessionId: 'term-once', osPid: 30573, lifecycle: 'running', lastActivityAt: 111 });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});
  const events = collectEvents(server);

  const termination: SessionTermination = server.handleRuntimeExit(record, null, 1);

  // Classification: signal-terminated → failed, exitCode preserved as null.
  assert.equal(termination.reason, 'signal');
  assert.equal(termination.lifecycle, 'failed');
  assert.equal(termination.exitCode, null);
  assert.equal(termination.signal, 1);
  assert.equal(termination.osPid, 30573);
  assert.equal(termination.previousLifecycle, 'running');
  assert.equal(termination.lastOutputAt, 111);

  // Record is stamped with the tombstone.
  const stamped = server.registry.getSession(record.sessionId);
  assert.equal(stamped.lifecycle, 'failed');
  assert.equal(stamped.termination.reason, 'signal');
  assert.equal(stamped.termination.exitCode, null);

  // session_exit event carries the nullable exitCode + signal + tombstone.
  const exitEvents = events.filter((e) => e.type === 'session_exit');
  assert.equal(exitEvents.length, 1, 'exactly one session_exit event');
  const exitEvent = exitEvents[0] as Extract<SessionHostEvent, { type: 'session_exit' }>;
  assert.equal(exitEvent.exitCode, null);
  assert.equal(exitEvent.signal, 1);
  assert.equal(exitEvent.termination?.reason, 'signal');

  // Exactly one termination host-log diagnostic, secret-free and structured.
  const diagnostics = server.getHostDiagnostics({ includeSessions: false, limit: 50 });
  const termLogs = diagnostics.recentLogs.filter((entry: SessionHostLogEntry) => entry.message.startsWith('session terminated:'));
  assert.equal(termLogs.length, 1, 'exactly one termination diagnostic');
  const log = termLogs[0];
  assert.equal(log.level, 'warn');
  assert.equal(log.sessionId, record.sessionId);
  assert.equal(log.data?.providerType, 'codex-cli');
  assert.equal(log.data?.osPid, 30573);
  assert.equal(log.data?.exitCode, null);
  assert.equal(log.data?.signal, 1);
  assert.equal(log.data?.reason, 'signal');
  assert.equal(log.data?.previousLifecycle, 'running');
  assert.equal(log.data?.lifecycle, 'failed');
  // No secrets: the launch env is never included in the diagnostic payload.
  assert.equal('env' in (log.data ?? {}), false);
  assert.equal('launchCommand' in (log.data ?? {}), false);
});

test('clean exit 0 records an info-level stopped termination', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-term-clean', storageRootDir: testStorageRoot }) as any;
  const record = buildRecord({ sessionId: 'term-clean', lifecycle: 'running' });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});

  const termination: SessionTermination = server.handleRuntimeExit(record, 0, null);
  assert.equal(termination.reason, 'exit');
  assert.equal(termination.lifecycle, 'stopped');

  const diagnostics = server.getHostDiagnostics({ includeSessions: false, limit: 50 });
  const termLogs = diagnostics.recentLogs.filter((entry: SessionHostLogEntry) => entry.message.startsWith('session terminated:'));
  assert.equal(termLogs.length, 1);
  assert.equal(termLogs[0].level, 'info');
});

test('nonzero exit records a failed termination distinct from clean stop', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-term-nonzero', storageRootDir: testStorageRoot }) as any;
  const record = buildRecord({ sessionId: 'term-nonzero', lifecycle: 'running' });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});

  const termination: SessionTermination = server.handleRuntimeExit(record, 137, null);
  assert.equal(termination.reason, 'failed');
  assert.equal(termination.lifecycle, 'failed');
  assert.equal(termination.exitCode, 137);
});

test('an explicit stop request is attributed in the termination diagnostic', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-term-stopctx', storageRootDir: testStorageRoot }) as any;
  const record = buildRecord({ sessionId: 'term-stopctx', lifecycle: 'running' });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});
  server.stopRequests.set(record.sessionId, 'stop');

  const termination: SessionTermination = server.handleRuntimeExit(record, 0, null);
  assert.equal(termination.requestedStop, 'stop');
  // The stop request is consumed so a later exit does not re-attribute it.
  assert.equal(server.stopRequests.has(record.sessionId), false);
});

test('a late persist arriving after cleanup does not resurrect the removed live file', async () => {
  const appName = `adhdev-test-term-resurrect-${process.pid}`;
  const server = new SessionHostServer({ appName, storageRootDir: testStorageRoot }) as any;
  const rootDir = testStorageRoot;
  const realSetTimeout = global.setTimeout;
  let cleanup: (() => void) | null = null;
  // Capture the 5s cleanup callback so the test can fire it deterministically.
  (global as any).setTimeout = (fn: () => void, ms?: number) => {
    if (ms === 5_000) {
      cleanup = fn;
      return { unref() {} } as any;
    }
    return realSetTimeout(fn as any, ms as any);
  };
  try {
    const sessionId = 'resurrect-race';
    const record = buildRecord({ sessionId, osPid: 4242, lifecycle: 'running' });
    server.registry.restoreSession(record);
    server.runtimes.set(sessionId, {});

    server.handleRuntimeExit(record, 0, null);
    // The live persistence file exists immediately after exit (post-mortem window).
    assert.equal(server.storage.loadAll().some((s: any) => s.record.sessionId === sessionId), true);

    // Fire the real cleanup timeout body.
    assert.ok(cleanup, 'cleanup timeout was not scheduled');
    cleanup!();
    assert.equal(server.storage.loadAll().some((s: any) => s.record.sessionId === sessionId), false);
    // The registry no longer serves this session either.
    assert.equal(server.registry.getSession(sessionId), null);

    // A stray late write (e.g. a PTY onData that raced the exit handler)
    // must not recreate the file for an already-removed session.
    server.persistNow(sessionId);
    assert.equal(server.storage.loadAll().some((s: any) => s.record.sessionId === sessionId), false);
  } finally {
    global.setTimeout = realSetTimeout;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a late persist is refused while the terminated record is still registered', () => {
  // The post-mortem window (between exit and the 5s cleanup) is the window the
  // resurrection actually happened in: the record is still registered, so a
  // late persist finds it and writes a stale live file. Guarding only on
  // "record removed" would miss this.
  const appName = `adhdev-test-term-postmortem-${process.pid}`;
  const server = new SessionHostServer({ appName, storageRootDir: testStorageRoot }) as any;
  const rootDir = testStorageRoot;
  try {
    const sessionId = 'postmortem-write';
    const record = buildRecord({ sessionId, osPid: 5150, lifecycle: 'running' });
    server.registry.restoreSession(record);
    server.runtimes.set(sessionId, {});

    server.handleRuntimeExit(record, 0, null);
    server.storage.remove(sessionId);

    // Record is still registered (cleanup has not fired yet) but is terminal.
    assert.ok(server.registry.getSession(sessionId));
    server.persistNow(sessionId);
    assert.equal(server.storage.loadAll().some((s: any) => s.record.sessionId === sessionId), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a restart reusing the sessionId keeps persisting and survives the old cleanup', () => {
  // restartRuntime() stops the runtime (scheduling a cleanup) and relaunches
  // under the SAME sessionId. Neither the deferred cleanup nor any persist
  // guard may treat the restarted live session as the terminated one.
  const appName = `adhdev-test-term-restart-reuse-${process.pid}`;
  const server = new SessionHostServer({ appName, storageRootDir: testStorageRoot }) as any;
  const rootDir = testStorageRoot;
  const realSetTimeout = global.setTimeout;
  let cleanup: (() => void) | null = null;
  (global as any).setTimeout = (fn: () => void, ms?: number) => {
    if (ms === 5_000) {
      cleanup = fn;
      return { unref() {} } as any;
    }
    return realSetTimeout(fn as any, ms as any);
  };
  try {
    const sessionId = 'restart-reuse';
    server.registry.restoreSession(buildRecord({ sessionId, osPid: 111, lifecycle: 'running' }));
    server.runtimes.set(sessionId, {});

    server.handleRuntimeExit(server.registry.getSession(sessionId), 0, null);

    // Restart: same id, live again (registry.restoreSession replaces the
    // terminated record, clearing the termination stamp).
    server.registry.deleteSession(sessionId);
    server.registry.restoreSession(buildRecord({ sessionId, osPid: 222, lifecycle: 'running' }));
    server.runtimes.set(sessionId, {});

    // The old exit's cleanup now fires — it must not touch the live session.
    assert.ok(cleanup, 'cleanup timeout was not scheduled');
    cleanup!();
    assert.ok(server.registry.getSession(sessionId), 'restarted live session was unregistered by a stale cleanup');

    // And the restarted session must still be persistable.
    server.persistNow(sessionId);
    const persisted = server.storage.loadAll().find((s: any) => s.record.sessionId === sessionId);
    assert.ok(persisted, 'restarted live session was permanently blocked from persisting');
    assert.equal(persisted.record.osPid, 222);
  } finally {
    global.setTimeout = realSetTimeout;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('handleRuntimeExit clears a pending scheduled persist so it cannot fire after cleanup', () => {
  const appName = `adhdev-test-term-clear-timer-${process.pid}`;
  const server = new SessionHostServer({ appName, storageRootDir: testStorageRoot }) as any;
  const rootDir = testStorageRoot;
  try {
    const sessionId = 'clear-timer';
    const record = buildRecord({ sessionId, osPid: 99, lifecycle: 'running' });
    server.registry.restoreSession(record);
    server.runtimes.set(sessionId, {});

    // Simulate onData scheduling a debounced persist just before exit.
    server.schedulePersist(sessionId);
    assert.equal(server.persistTimers.has(sessionId), true);

    server.handleRuntimeExit(record, 0, null);

    // The pending timer from before exit must be cleared, not left to fire later.
    assert.equal(server.persistTimers.has(sessionId), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a live persist still succeeds for a session that was never removed', () => {
  const appName = `adhdev-test-term-live-persist-${process.pid}`;
  const server = new SessionHostServer({ appName, storageRootDir: testStorageRoot }) as any;
  const rootDir = testStorageRoot;
  try {
    const sessionId = 'still-live';
    const record = buildRecord({ sessionId, osPid: 7, lifecycle: 'running' });
    server.registry.restoreSession(record);
    server.runtimes.set(sessionId, {});

    server.persistNow(sessionId);
    assert.equal(server.storage.loadAll().some((s: any) => s.record.sessionId === sessionId), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('tombstone is retained on disk after the live runtime record is removed', () => {
  const appName = `adhdev-test-term-disk-${process.pid}`;
  const storage = new SessionHostStorage({ appName, rootDir: testStorageRoot });
  const rootDir = testStorageRoot;
  try {
    const sessionId = 'disk-tombstone';
    const record = buildRecord({ sessionId, osPid: 42, lifecycle: 'running' });
    const snapshot = { seq: 1, text: 'output', truncated: false };
    storage.save(record, snapshot);
    const termination: SessionTermination = {
      exitCode: null,
      signal: 1,
      reason: 'signal',
      lifecycle: 'failed',
      terminatedAt: Date.now(),
      osPid: 42,
    };
    storage.saveTombstone(sessionId, termination);

    // Simulate the post-exit live-record cleanup.
    storage.remove(sessionId);

    // Live runtime file is gone...
    assert.equal(storage.loadAll().some((s) => s.record.sessionId === sessionId), false);
    // ...but the tombstone survives and is inspectable.
    const loaded = storage.loadTombstone(sessionId);
    assert.notEqual(loaded, null);
    assert.equal(loaded?.termination.reason, 'signal');
    assert.equal(loaded?.termination.exitCode, null);
    assert.equal(loaded?.termination.signal, 1);
    assert.equal(loaded?.termination.osPid, 42);
    assert.equal(storage.loadAllTombstones().length, 1);

    // Explicit removal clears the tombstone too.
    storage.removeTombstone(sessionId);
    assert.equal(storage.loadTombstone(sessionId), null);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
