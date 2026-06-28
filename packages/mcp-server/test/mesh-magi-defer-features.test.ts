import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildInlineMagiPanel,
    classifyStaleReplicas,
    findMagiReplicaTasks,
} from '../src/tools/mesh-tools.js';

// ─── featureB: inline ad-hoc panels ─────────────

test('buildInlineMagiPanel normalizes inline members like a named panel', () => {
    const panel = buildInlineMagiPanel([
        { nodeId: 'win32-main', provider: '  claude-cli  ' },
        { provider: 'codex-cli', capabilityTags: ['os=darwin', 'os=darwin'], n: 2 },
    ], { defaultN: 1 });
    assert.equal(panel.members.length, 2);
    // provider trimmed, duplicate tags deduped, dedupExempt defaulted true.
    assert.equal(panel.members[0].provider, 'claude-cli');
    assert.equal(panel.members[0].nodeId, 'win32-main');
    assert.deepEqual(panel.members[1].capabilityTags, ['os=darwin']);
    assert.equal(panel.members[1].n, 2);
    assert.equal(panel.defaultN, 1);
    assert.equal(panel.dedupExempt, true);
});

test('buildInlineMagiPanel rejects an empty list and a member missing provider', () => {
    assert.throws(() => buildInlineMagiPanel([]), /invalid_magi_panel/);
    assert.throws(() => buildInlineMagiPanel([{}]), /provider is required/);
});

// ─── featureC: poll-by-group discovery ──────────

test('findMagiReplicaTasks returns only the tasks carrying the consensus group id', () => {
    const queue = [
        { id: 't1', consensusGroupId: 'magi_abc', status: 'completed' },
        { id: 't2', consensusGroupId: 'magi_abc', status: 'assigned' },
        { id: 't3', consensusGroupId: 'magi_other', status: 'completed' },
        { id: 't4', status: 'pending' },
    ];
    const found = findMagiReplicaTasks(queue, 'magi_abc');
    assert.deepEqual(found.map(t => t.id).sort(), ['t1', 't2']);
});

test('findMagiReplicaTasks returns empty for a blank or unknown group id', () => {
    const queue = [{ id: 't1', consensusGroupId: 'magi_abc' }];
    assert.equal(findMagiReplicaTasks(queue, '').length, 0);
    assert.equal(findMagiReplicaTasks(queue, '   ').length, 0);
    assert.equal(findMagiReplicaTasks(queue, 'magi_missing').length, 0);
});

// ─── featureA: stale replica detection ──────────

test('classifyStaleReplicas flags non-terminal staleAssigned tasks and skips terminal/live ones', () => {
    const annotated = [
        { id: 't1', status: 'completed', staleAssigned: false },
        { id: 't2', status: 'assigned', staleAssigned: true, staleReason: 'assigned session is not live on the assigned node' },
        { id: 't3', status: 'assigned', staleAssigned: false },
        // A terminal task is never stale even if it somehow carries the flag.
        { id: 't4', status: 'failed', staleAssigned: true, staleReason: 'x' },
    ];
    const { staleTaskIds, staleReasons } = classifyStaleReplicas(annotated);
    assert.deepEqual([...staleTaskIds], ['t2']);
    assert.equal(staleReasons['t2'], 'assigned session is not live on the assigned node');
    assert.equal(staleReasons['t4'], undefined);
});

test('classifyStaleReplicas tolerates an empty / non-array input', () => {
    assert.equal(classifyStaleReplicas([]).staleTaskIds.size, 0);
    assert.equal(classifyStaleReplicas(undefined as any).staleTaskIds.size, 0);
});
