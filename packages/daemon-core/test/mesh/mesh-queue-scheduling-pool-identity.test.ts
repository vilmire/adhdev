import { describe, expect, it } from 'vitest';
import { __buildSchedulingPoolForTests } from '../../src/mesh/mesh-queue-assignment.js';

// Canon-identity regression guard for the scheduling pool (TASK 6-3 / A-2).
//
// A mesh node's stable id flows through several serialization forms with the same
// value — config `id`, wire `nodeId`, DB `node_id`. Idle candidates eligible to
// claim a queued task are gathered from two sources that do NOT agree on which
// form they carry: local candidates stamp the CLI instance's `meshNodeId`
// setting, remote candidates stamp the registered remote-idle-session `nodeId`.
// The scheduling pool then keys everything (Set dedup, base index, rank index,
// per-node active load) by raw-string equality.
//
// If the SAME physical node contributes one local candidate under form A and one
// remote candidate under form B, a raw-string pool would treat them as two
// distinct nodes — splitting the node's load accounting and double-ranking it in
// the round-robin spread (a silent scheduling defect). buildSchedulingPool
// canonicalizes every candidate's nodeId via its resolved node record first, so
// mixed forms of one node collapse to a single unique-node entry.

function candidate(
    origin: 'local' | 'remote',
    nodeId: string,
    node: any,
    sessionId: string,
) {
    return { nodeId, sessionId, providerType: 'claude-cli', origin, node };
}

describe('buildSchedulingPool — canonical node identity', () => {
    it('collapses mixed-form candidates for the SAME node into one unique node', () => {
        // Same physical node record, but the two candidates reference its id under
        // two different forms: the local candidate under the wire `nodeId` form,
        // the remote candidate under the DB `node_id` form. The resolved node
        // record itself carries the config `id` (the canonical form).
        const nodeRecord = { id: 'node_alpha', policy: {} };
        const local = candidate('local', 'node_alpha', nodeRecord, 's-local');
        const remote = candidate('remote', 'node_alpha', nodeRecord, 's-remote');

        const { pool, uniqueNodes } = __buildSchedulingPoolForTests([local], [remote]);

        // Both candidates survive in the drain pool (each is a separately
        // claimable idle session)...
        expect(pool).toHaveLength(2);
        // ...but they resolve to ONE unique node, not two — no form-drift split.
        expect(uniqueNodes).toHaveLength(1);
        expect(uniqueNodes[0].nodeId).toBe('node_alpha');
        expect(uniqueNodes[0].node).toBe(nodeRecord);
        // Every pooled candidate now carries the canonical form.
        expect(pool.map(c => c.nodeId)).toEqual(['node_alpha', 'node_alpha']);
    });

    it('normalizes each candidate id to the resolved node canonical form', () => {
        // The node record is only reachable under its DB `node_id` field; the local
        // candidate arrived stamped with the wire `nodeId` form of the same value.
        // Canonicalization must rewrite the candidate id to the normalized value so
        // downstream `=== nodeId` keying agrees.
        const nodeRecord = { node_id: 'node_beta' };
        const local = candidate('local', 'node_beta', nodeRecord, 's1');

        const { pool, uniqueNodes } = __buildSchedulingPoolForTests([local], []);

        expect(pool[0].nodeId).toBe('node_beta');
        expect(uniqueNodes).toHaveLength(1);
        expect(uniqueNodes[0].nodeId).toBe('node_beta');
    });

    it('keeps genuinely distinct nodes separate', () => {
        const a = { id: 'node_a', policy: {} };
        const b = { id: 'node_b', policy: {} };
        const { pool, uniqueNodes } = __buildSchedulingPoolForTests(
            [candidate('local', 'node_a', a, 's-a')],
            [candidate('remote', 'node_b', b, 's-b')],
        );

        expect(pool).toHaveLength(2);
        expect(uniqueNodes).toHaveLength(2);
        expect(uniqueNodes.map(n => n.nodeId).sort()).toEqual(['node_a', 'node_b']);
    });

    it('falls back to the raw candidate id when the node is unresolved', () => {
        // An idle candidate whose mesh node record was not found (node === null)
        // cannot be normalized; it must retain its raw id rather than collapse to
        // an empty key (which would wrongly merge every unresolved candidate).
        const { pool, uniqueNodes } = __buildSchedulingPoolForTests(
            [candidate('local', 'node_orphan_1', null, 's1')],
            [candidate('remote', 'node_orphan_2', null, 's2')],
        );

        expect(pool.map(c => c.nodeId).sort()).toEqual(['node_orphan_1', 'node_orphan_2']);
        expect(uniqueNodes).toHaveLength(2);
    });

    it('preserves candidate order and index assignment across the merged pool', () => {
        const n1 = { id: 'n1' };
        const n2 = { id: 'n2' };
        const { uniqueNodes } = __buildSchedulingPoolForTests(
            [candidate('local', 'n1', n1, 's1')],
            [candidate('remote', 'n2', n2, 's2')],
        );
        // Local candidates precede remote ones (local-first drain order), and the
        // unique-node index reflects first appearance.
        expect(uniqueNodes[0]).toMatchObject({ nodeId: 'n1', index: 0 });
        expect(uniqueNodes[1]).toMatchObject({ nodeId: 'n2', index: 1 });
    });
});
