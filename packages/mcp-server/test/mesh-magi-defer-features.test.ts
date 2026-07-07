import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyStaleReplicas,
    findMagiReplicaTasks,
} from '../src/tools/mesh-tools.js';

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
