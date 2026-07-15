import { describe, it, expect, beforeEach } from 'vitest';

import {
  ChatSourceRegistry,
  buildV1NativePresentObservation,
  buildV2NativePresentObservation,
  chatSourceSessionKey,
  TRANSITION_HISTORY_LIMIT,
} from '../../src/chat/source-resolver.js';

describe('ChatSourceRegistry — per-session state', () => {
  let registry: ChatSourceRegistry;
  beforeEach(() => { registry = new ChatSourceRegistry(); });

  it('keeps state isolated per (providerType, sessionId)', () => {
    const aKey = chatSourceSessionKey('claude-cli', 'session-a');
    const bKey = chatSourceSessionKey('claude-cli', 'session-b');
    registry.observe(aKey, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'msg1', sequence: 1 }],
      coverage: 'full',
      safeMapping: true,
    }));
    expect(registry.getState(aKey).name).toBe('NativeLocked');
    expect(registry.getState(bKey).name).toBe('Booting');
  });

  it('records transitions in insertion order and caps at TRANSITION_HISTORY_LIMIT', () => {
    const key = chatSourceSessionKey('codex-cli', 'sess');
    // First observation: Booting → NativeLocked
    registry.observe(key, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'a', sequence: 1 }],
      coverage: 'full',
      safeMapping: true,
    }));
    // Now alternate progress vs regression beyond the cap.
    for (let i = 0; i < TRANSITION_HISTORY_LIMIT + 10; i += 1) {
      registry.observe(key, { kind: 'native_unavailable', reason: 'read_error' });
      registry.observe(key, buildV2NativePresentObservation({
        messages: [{ providerUnitKey: 'a', sequence: 100 + i }],
        coverage: 'full',
        safeMapping: true,
      }));
    }
    expect(registry.getTransitions(key).length).toBeLessThanOrEqual(TRANSITION_HISTORY_LIMIT);
  });

  it('collapses consecutive identical no-op transitions', () => {
    const key = chatSourceSessionKey('claude-cli', 'collapse');
    registry.observe(key, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'a', sequence: 1 }],
      coverage: 'full',
      safeMapping: true,
    }));
    // 10 consecutive identical holds — should not bloat the buffer.
    for (let i = 0; i < 10; i += 1) {
      registry.observe(key, buildV2NativePresentObservation({
        messages: [{ providerUnitKey: 'a', sequence: 1 }],
        coverage: 'full',
        safeMapping: true,
      }));
    }
    // First transition (Booting→NativeLocked NativeProgressed) and the
    // first hold (NativeLocked→NativeLocked NoOp); subsequent identical
    // holds collapse.
    expect(registry.getTransitions(key).length).toBe(2);
  });

  it('snapshotRecord/restoreRecord roundtrips a NativeLocked state (STICKY-NATIVE rollback)', () => {
    // Models the STICKY-NATIVE hold in decideCliReadChatSource: snapshot a
    // native-committed session, speculatively observe an empty/regressed read
    // that flips it to pty-parser, then roll back so provenance stays native.
    const key = chatSourceSessionKey('cursor-cli', 'sticky');
    registry.observe(key, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'u1', sequence: 1 }, { providerUnitKey: 'a1', sequence: 2 }],
      coverage: 'full',
      safeMapping: true,
    }));
    expect(registry.getState(key).name).toBe('NativeLocked');

    const snap = registry.snapshotRecord(key);
    expect(snap).toBeDefined();

    // A transient empty read flips the machine to PtyOnly/Recovering.
    const decision = registry.observe(key, { kind: 'native_unavailable', reason: 'empty' });
    expect(decision.selected).toBe('pty-parser');
    expect(registry.getState(key).name).not.toBe('NativeLocked');

    // Roll back: the session is native-committed again, exactly as before.
    registry.restoreRecord(key, snap);
    expect(registry.getState(key).name).toBe('NativeLocked');
    expect(registry.getState(key).committedUnitKeys.has('a1')).toBe(true);
  });

  it('restoreRecord(undefined) clears a key that had no prior record', () => {
    const key = chatSourceSessionKey('cursor-cli', 'noprior');
    expect(registry.snapshotRecord(key)).toBeUndefined();
    registry.observe(key, { kind: 'native_unavailable', reason: 'empty' });
    registry.restoreRecord(key, undefined);
    expect(registry.getState(key).name).toBe('Booting');
  });

  it('clear() removes a single session, clearAll() removes all', () => {
    const a = chatSourceSessionKey('p', 'a');
    const b = chatSourceSessionKey('p', 'b');
    registry.observe(a, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'm', sequence: 1 }], coverage: 'full', safeMapping: true,
    }));
    registry.observe(b, buildV2NativePresentObservation({
      messages: [{ providerUnitKey: 'm', sequence: 1 }], coverage: 'full', safeMapping: true,
    }));
    registry.clear(a);
    expect(registry.getState(a).name).toBe('Booting');
    expect(registry.getState(b).name).toBe('NativeLocked');
    registry.clearAll();
    expect(registry.getState(b).name).toBe('Booting');
  });
});

describe('buildV1NativePresentObservation — v1 identity synthesis', () => {
  it('prefers existing providerUnitKey when present', () => {
    const obs = buildV1NativePresentObservation({
      providerType: 'codex-cli',
      sessionId: 'sess',
      messages: [{ providerUnitKey: 'real-key', role: 'user', receivedAt: 1000 }],
      coverage: 'tail',
      safeMapping: true,
    });
    if (obs.kind !== 'native_present') throw new Error('expected native_present');
    expect(obs.messages[0]!.providerUnitKey).toBe('real-key');
  });

  it('falls back to bubbleId, then id, before synthesising', () => {
    const obs = buildV1NativePresentObservation({
      providerType: 'codex-cli',
      sessionId: 'sess',
      messages: [
        { bubbleId: 'bub-1' },
        { id: 'id-2' },
        { role: 'user', receivedAt: 1000 }, // synthesised
      ],
      coverage: 'tail',
      safeMapping: true,
    });
    if (obs.kind !== 'native_present') throw new Error('expected native_present');
    expect(obs.messages[0]!.providerUnitKey).toBe('bub-1');
    expect(obs.messages[1]!.providerUnitKey).toBe('id-2');
    expect(obs.messages[2]!.providerUnitKey).toMatch(/^v1:codex-cli:sess:1000:2:user$/);
  });

  it('synthesises sequence from receivedAt/timestamp/index, else positional', () => {
    const obs = buildV1NativePresentObservation({
      providerType: 'claude-cli',
      sessionId: 's',
      messages: [
        { receivedAt: 5000, role: 'user' },
        { timestamp: 6000, role: 'assistant' },
        { index: 42, role: 'assistant' },
        { role: 'assistant' }, // positional 3
      ],
      coverage: 'tail',
      safeMapping: true,
    });
    if (obs.kind !== 'native_present') throw new Error('expected native_present');
    expect(obs.messages.map((m) => m.sequence)).toEqual([5000, 6000, 42, 3]);
  });

  it('produces stable keys across two identical-input calls (no clock dep)', () => {
    const args = {
      providerType: 'claude-cli',
      sessionId: 's',
      messages: [{ role: 'user', receivedAt: 1234 }],
      coverage: 'tail' as const,
      safeMapping: true,
    };
    const a = buildV1NativePresentObservation(args);
    const b = buildV1NativePresentObservation(args);
    if (a.kind !== 'native_present' || b.kind !== 'native_present') throw new Error('expected native_present');
    expect(a.messages[0]!.providerUnitKey).toBe(b.messages[0]!.providerUnitKey);
  });
});
