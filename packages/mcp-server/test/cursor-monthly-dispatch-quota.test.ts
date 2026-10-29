import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDirectDispatchQuotaGate, buildQuotaExhaustedDispatchFailure } from '../src/tools/mesh-remote-dispatch.js';

test('direct Cursor dispatch gates the 30d window and reports its exact monthly reset', () => {
    const now = Date.now();
    const resetsAt = now + (6 * 24 + 4) * 3_600_000;
    const monthly = { usedPercent: 12.1, windowMinutes: 43200, resetsAt };
    const node = { id: 'cursor-monthly-node', nodeFacts: { reportedAt: now, quota: {
        'cursor-cli': { provider: 'cursor-cli', session: null, weekly: null, monthly, updatedAt: now, status: 'ok', error: null },
    } } } as any;
    assert.equal(checkDirectDispatchQuotaGate(node, 'cursor-cli', null), null);
    monthly.usedPercent = 100;
    const gate = checkDirectDispatchQuotaGate(node, 'cursor-cli', null)!;
    assert.equal(gate.block.window, 'monthly');
    assert.equal(gate.resetsAt, resetsAt);
    const failure = buildQuotaExhaustedDispatchFailure(node, 'cursor-cli', 'session', gate);
    assert.deepEqual(failure.quotaBlock, {
        reason: 'provider_quota_monthly_low', window: 'monthly', remainingPercent: 0,
        thresholdPercent: 15, resetsAt,
    });
    assert.ok(String(failure.error).includes(new Date(resetsAt).toISOString()));
    assert.doesNotMatch(String(failure.error), /weekly|7d/);
});
