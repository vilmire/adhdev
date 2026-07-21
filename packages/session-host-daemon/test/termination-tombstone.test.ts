import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionHostServer } from '../src/server.js';
import { SessionHostStorage } from '../src/storage.js';
import type { SessionHostEvent, SessionHostLogEntry, SessionHostRecord, SessionTermination } from '@adhdev/session-host-core';

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
  const server = new SessionHostServer({ appName: 'adhdev-test-term-once' }) as any;
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
  const server = new SessionHostServer({ appName: 'adhdev-test-term-clean' }) as any;
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
  const server = new SessionHostServer({ appName: 'adhdev-test-term-nonzero' }) as any;
  const record = buildRecord({ sessionId: 'term-nonzero', lifecycle: 'running' });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});

  const termination: SessionTermination = server.handleRuntimeExit(record, 137, null);
  assert.equal(termination.reason, 'failed');
  assert.equal(termination.lifecycle, 'failed');
  assert.equal(termination.exitCode, 137);
});

test('an explicit stop request is attributed in the termination diagnostic', () => {
  const server = new SessionHostServer({ appName: 'adhdev-test-term-stopctx' }) as any;
  const record = buildRecord({ sessionId: 'term-stopctx', lifecycle: 'running' });
  server.registry.restoreSession(record);
  server.runtimes.set(record.sessionId, {});
  server.stopRequests.set(record.sessionId, 'stop');

  const termination: SessionTermination = server.handleRuntimeExit(record, 0, null);
  assert.equal(termination.requestedStop, 'stop');
  // The stop request is consumed so a later exit does not re-attribute it.
  assert.equal(server.stopRequests.has(record.sessionId), false);
});

test('tombstone is retained on disk after the live runtime record is removed', () => {
  const appName = `adhdev-test-term-disk-${process.pid}`;
  const storage = new SessionHostStorage({ appName });
  const rootDir = path.join(os.homedir(), '.adhdev', 'session-host', appName);
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
