import assert from 'node:assert/strict';
import test from 'node:test';

import { slimLedgerPayload, compactRoutingDecision } from '../src/tools/mesh-tools-internal.js';

// LEDGER-TASK-TRACEABILITY (E1): slimLedgerPayload must preserve the task_dispatched
// routingDecision sub-object even in compact mode (it is the whole point of the entry),
// while keeping the message/finalSummary truncation policy for other fields.

test('slimLedgerPayload preserves routingDecision scalars in compact mode', () => {
    const payload = {
        taskId: 'task-1',
        message: 'x'.repeat(500),
        routingDecision: {
            source: 'autoLaunch',
            selectedNodeId: 'node_a',
            daemonId: 'daemon_mach_1',
            fitnessScore: 121,
            resolvedProviderType: 'claude-cli',
            resolvedModel: 'opus',
            resolvedThinkingLevel: 'high',
            reason: 'ok',
        },
    };
    const slim = slimLedgerPayload(payload) as any;
    // message is still truncated by the existing policy.
    assert.ok(typeof slim.message === 'string' && slim.message.length <= 201);
    // routingDecision survives intact.
    assert.equal(slim.routingDecision.source, 'autoLaunch');
    assert.equal(slim.routingDecision.selectedNodeId, 'node_a');
    assert.equal(slim.routingDecision.fitnessScore, 121);
    assert.equal(slim.routingDecision.resolvedModel, 'opus');
    assert.equal(slim.routingDecision.resolvedThinkingLevel, 'high');
});

test('compactRoutingDecision bounds skippedCandidates and reports the dropped count', () => {
    const skipped = Array.from({ length: 9 }, (_, i) => ({ nodeId: `node_${i}`, reason: 'cap' }));
    const out = compactRoutingDecision({ source: 'autoLaunch', skippedCandidates: skipped }) as any;
    assert.equal(out.source, 'autoLaunch');
    assert.equal(out.skippedCandidates.length, 5);
    assert.equal(out.skippedCandidatesDropped, 4);
});

test('compactRoutingDecision keeps a short skippedCandidates list without a dropped count', () => {
    const out = compactRoutingDecision({
        source: 'queue',
        skippedCandidates: [{ nodeId: 'a', reason: 'dirty_workspace' }],
    }) as any;
    assert.equal(out.skippedCandidates.length, 1);
    assert.equal(out.skippedCandidatesDropped, undefined);
});
