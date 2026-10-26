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
