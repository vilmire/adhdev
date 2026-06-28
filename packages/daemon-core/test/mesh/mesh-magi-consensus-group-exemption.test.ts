import { describe, expect, it } from 'vitest';
import { buildPendingEventFingerprint, type PendingMeshCoordinatorEvent } from '../../src/mesh/mesh-events-pending.js';

// MAGI fan-out sends the SAME prompt to N replicas intentionally — the opposite of
// the accidental duplicates the dedup collapses. A consensusGroupId in the event
// metadata anchors the fingerprint on (taskId, consensusGroupId) so grouped replicas
// can never be collapsed, even if the builder were ever re-anchored on prompt content.
describe('buildPendingEventFingerprint — MAGI consensus-group exemption', () => {
    const base = (overrides: Partial<PendingMeshCoordinatorEvent> & { metadataEvent: Record<string, unknown> }): PendingMeshCoordinatorEvent => ({
        event: 'agent:generating_started',
        meshId: 'mesh_x',
        nodeId: 'node_1',
        nodeLabel: 'node_1',
        queuedAt: 0,
        ...overrides,
    });

    it('anchors a grouped event on (taskId, consensusGroupId, "group")', () => {
        const fp = buildPendingEventFingerprint(base({
            metadataEvent: { sessionId: 's1', taskId: 't1', consensusGroupId: 'magi_abc', timestamp: 1 },
        }));
        expect(fp).toContain('group');
        expect(fp).toContain('magi_abc');
        expect(fp).toContain('t1');
    });

    it('never collapses two replicas of the same group (distinct taskIds)', () => {
        const a = base({ metadataEvent: { sessionId: 's1', taskId: 't1', consensusGroupId: 'magi_abc', timestamp: 5 } });
        const b = base({ metadataEvent: { sessionId: 's2', taskId: 't2', consensusGroupId: 'magi_abc', timestamp: 5 } });
        expect(buildPendingEventFingerprint(a)).not.toBe(buildPendingEventFingerprint(b));
    });

    it('reads consensusGroupId from a nested payload too', () => {
        const fp = buildPendingEventFingerprint(base({
            metadataEvent: { sessionId: 's1', payload: { taskId: 't9', consensusGroupId: 'magi_z' } },
        }));
        expect(fp).toContain('magi_z');
        expect(fp).toContain('t9');
    });

    it('ignored when no consensusGroupId is present (ordinary tasks keep the generic key)', () => {
        const fp = buildPendingEventFingerprint(base({
            metadataEvent: { sessionId: 's1', taskId: 't1', timestamp: 1 },
        }));
        expect(fp).not.toContain('group');
    });
});
