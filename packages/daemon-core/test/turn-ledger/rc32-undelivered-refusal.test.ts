import { expect, it } from 'vitest';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { NOW, POLICY, ev, makeAttempt } from './fixtures.js';
import { agentCommand } from '../../src/commands/cli-manager-agent-command.js';

it('host explicitly refuses a missing adapter before dispatch and retires the undelivered direct attempt', async () => {
    const answer = await agentCommand({ findAdapter: () => undefined } as any, { agentType: 'cursor-cli', action: 'send_chat', targetSessionId: 'starting' });
    expect(answer).toMatchObject({ success: false, code: 'dispatch_not_started' });
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct' }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: answer.code }, { source: 'dispatch' }) });
    expect(result.attempt?.terminal?.reason).toBe('dispatch_failed');
    expect(result.effects.some(e => e.kind === 'cancel_dispatch')).toBe(false);
});
it.each(['transport_error', 'rejected_by_worker'] as const)('an uncertain %s still retains the writer claim', reason => {
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct' }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason }, { source: 'dispatch' }) });
    expect(result.attempt?.state).toBe('stopping'); expect(result.attempt?.terminal).toBeNull();
});
it('never trusts a not-started refusal after delivery', () => {
    const result = reduce({ attempt: makeAttempt('delivered', { scope: 'mesh_direct', deliveredAt: NOW - 1 }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch' }) });
    expect(result.attempt?.terminal).toBeNull();
});

it('node-scoped WTCLAIM refusal proves no adapter, provider fallback or input submission occurred', async () => {
    const answer = await agentCommand({
        findMeshNodeAdapter: () => null,
        findAdapter: () => { throw new Error('must not use provider fallback'); },
        input: { submit: () => { throw new Error('must not submit'); } },
    } as any, { agentType: 'cursor-cli', action: 'send_chat', meshContext: { nodeId: 'missing-node' } } as any);
    expect(answer).toMatchObject({ success: false, code: 'dispatch_not_started' });
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct' }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: answer.code }, { source: 'dispatch' }) });
    expect(result.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'dispatch_failed' });
    expect(result.effects.some(e => e.kind === 'release_attempt_ref')).toBe(true);
    expect(result.effects.some(e => e.kind === 'cancel_dispatch')).toBe(false);
});

it.each([
    { label: 'no attempt ref', envelope: { attemptRef: undefined } },
    { label: 'foreign attempt', envelope: { attemptRef: { attemptId: 'other', generation: 1 } } },
    { label: 'old generation', envelope: { attemptRef: { attemptId: 'a1', generation: 0 } } },
    { label: 'future generation', envelope: { attemptRef: { attemptId: 'a1', generation: 2 } } },
    { label: 'foreign session', envelope: { sessionId: 'replacement-session' } },
    { label: 'probe source', envelope: { source: 'coordinator_probe' as const } },
])('$label cannot retire an attempt using a not-started code', ({ envelope }) => {
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct' }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch', ...envelope }) });
    expect(result.attempt?.terminal).toBeNull();
    expect(result.effects.some(e => e.kind === 'release_attempt_ref')).toBe(false);
});

it.each([
    { consumedAt: NOW - 1 }, { lastActivityAt: NOW - 1 },
    { lastLiveness: 'alive' as const }, { lastLiveness: 'unknown' as const },
    { lastLiveness: 'read_failed' as const },
    { redriveCount: 1 }, { reclaimCount: 1 },
])('conflicting writer observations retain ownership: %j', observation => {
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct', ...observation }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch' }) });
    expect(result.attempt?.state).toBe('stopping');
    expect(result.attempt?.terminal).toBeNull();
});

it('transport absence cannot masquerade as a confirmed worker refusal', () => {
    const result = reduce({ attempt: makeAttempt('accepted', { scope: 'mesh_direct' }), holds: [], nowMs: NOW, policy: POLICY,
        evidence: ev('dispatch_failed', { workerAbsent: true, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch' }) });
    expect(result.attempt?.state).toBe('stopping');
    expect(result.attempt?.terminal).toBeNull();
});

it('persisted never-started settlement releases only its exclusive session claim and deduplicates late ACKs', async () => {
    const { memDb, ledgerOn, dispatch, evd, recordingPorts, rowsOf } = await import('./ledger-harness.js');
    const db = memDb(); const ports = recordingPorts(); const ledger = ledgerOn(db, { ports });
    try {
        ledger.observe(dispatch());
        ledger.observe(dispatch({ attemptId: 'other-attempt', taskId: 'other-task', session: 'other-session' }));
        const refusal = evd('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch' });
        expect(ledger.observe(refusal).attempt?.terminal?.reason).toBe('dispatch_failed');
        expect(ledger.openAttemptForSession('s1')).toBeNull();
        expect(ledger.openAttemptForSession('other-session')?.attemptId).toBe('other-attempt');
        expect(ledger.observe(refusal).verdict).toBe('duplicate');
        expect(ledger.observe(dispatch({ attemptId: 'replacement', taskId: 'replacement-task' })).verdict).toBe('applied');
        // A late ACK and repeat refusal still name the retired attempt, never
        // the new assignment that now owns the same session.
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'dispatch' }));
        ledger.observe(evd('dispatch_failed', { workerAbsent: false, reason: 'rejected_by_worker', refusalCode: 'dispatch_not_started' }, { source: 'dispatch' }));
        expect(ledger.openAttemptForSession('s1')?.attemptId).toBe('replacement');
        expect(ledger.getAttempt('a1')?.terminal?.outcome).toBe('failed');
        expect(rowsOf(db, 'committed', 'a1')).toHaveLength(1);
        expect(ports.calls.filter(c => c === 'release:a1')).toHaveLength(1);
        expect(ports.cancels).toHaveLength(0);
    } finally { db.close(); }
});

it.each(['mesh_direct', 'mesh_queue'] as const)('uncertain %s dispatch keeps its persisted exclusive claim', async scope => {
    const { memDb, ledgerOn, dispatch, evd, recordingPorts } = await import('./ledger-harness.js');
    const db = memDb(); const ports = recordingPorts(); const ledger = ledgerOn(db, { ports });
    try {
        ledger.observe(dispatch({ scope }));
        ledger.observe(evd('dispatch_failed', { workerAbsent: false, reason: 'transport_error' }, { source: 'dispatch' }));
        expect(ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', terminal: null, generation: 0 });
        expect(ledger.openAttemptForSession('s1')?.attemptId).toBe('a1');
        expect(ledger.observe(dispatch({ attemptId: 'replacement', taskId: 'replacement-task' })).verdict).toBe('rejected');
        expect(ports.calls).not.toContain('release:a1');
    } finally { db.close(); }
});
