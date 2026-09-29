/**
 * mesh.status is the dashboard mesh view's ONE lane (data-path audit
 * 2026-09-29 P1-5): the coordinator's held mesh_status as a snapshot on
 * subscribe, then keyed per-node / per-task deltas. This pins the bytes:
 *
 *   - an idle mesh (only the build stamp and live counters move) sends ZERO
 *     bytes on any number of flushes;
 *   - one node's change yields a delta for THAT node only (changed fields);
 *   - subscribers of another mesh get nothing; a failed send falls back to a
 *     snapshot; a mesh build that is in flight is never duplicated.
 */
import { describe, expect, it } from 'vitest';
import { foldKeyedDoc, MESH_STATUS_DOC_SPEC } from '@adhdev/mesh-shared';

import type { TopicSink } from '../../src/subscriptions/topic-registry.js';
import { TopicSubscriptionRegistry } from '../../src/subscriptions/topic-registry.js';
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared';

function node(nodeId: string, headCommit: string, observedAt: number) {
    return {
        nodeId,
        workspace: `/repo/${nodeId}`,
        machineLabel: nodeId,
        health: 'online',
        providers: ['claude-cli'],
        git: { isGitRepo: true, branch: 'main', headCommit, ahead: 0, behind: 0, submodules: [{ path: 'oss', commit: 'x'.repeat(40) }] },
        gitObservation: { source: 'member_push', observedAt, refreshing: false, unreachableSince: null },
        activeSessionDetails: [{ sessionId: `${nodeId}-s1`, state: 'idle', providerType: 'claude-cli' }],
        nodeFacts: { schemaVersion: 1, reportedAt: 1, quota: { 'claude-cli': { status: 'ok' } } },
    };
}

function harness() {
    const frames: Array<{ connectionId: string; bytes: number; update: Record<string, any> }> = [];
    let deliver = true;
    const sink: TopicSink = {
        send: (connectionId, _t, update) => {
            if (!deliver) return false;
            frames.push({ connectionId, bytes: JSON.stringify(update).length, update: update as any });
            return true;
        },
        isDeliverable: () => true,
        isAlive: () => true,
    };
    let clock = 1_000;
    let builds = 0;
    const heads: Record<string, string> = { n1: 'aaa', n2: 'bbb', n3: 'ccc' };
    const registry = new TopicSubscriptionRegistry(sink, {
        now: () => clock,
        sources: {
            meshStatus: async (meshId) => {
                builds += 1;
                return {
                    success: true,
                    meshId,
                    meshName: 'Mesh',
                    repoIdentity: 'github.com/acme/repo',
                    refreshedAt: new Date(clock).toISOString(),
                    turnPresentationCounters: { projectionSource: { turn_reducer: builds, provider_fsm_fallback: 0 } },
                    nodes: Object.entries(heads).map(([id, head]) => node(id, head, 500)),
                    queue: { summary: { pending: 1 }, tasks: [{ id: 't1', status: 'pending', message: 'x'.repeat(300) }] },
                    missions: [{ id: 'mi1', status: 'active', goalPreview: 'goal' }],
                };
            },
        },
    });
    registry.subscribe('c1', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'mesh.status', key: 'mesh:status:m1', params: { meshId: 'm1' } });
    return {
        registry,
        frames,
        heads,
        builds: () => builds,
        flush: async (meshId?: string) => { clock += 5_000; await registry.flushMeshStatus(meshId); },
        setDeliver: (value: boolean) => { deliver = value; },
    };
}

describe('mesh.status keyed delta — bytes per change', () => {
    it('sends the snapshot first, then ZERO bytes for an idle mesh on every flush', async () => {
        const h = harness();
        await h.registry.flushNow('mesh.status', 'c1', 'mesh:status:m1');
        expect(h.frames).toHaveLength(1);
        expect(h.frames[0]!.update).toMatchObject({ topic: 'mesh.status', mode: 'snapshot', meshId: 'm1', seq: 1 });
        expect(h.frames[0]!.update.status.nodes).toHaveLength(3);
        for (let i = 0; i < 20; i++) await h.flush();
        // Build stamp + live counters moved every time — still nothing sent.
        expect(h.frames).toHaveLength(1);
    });

    it('one node change yields a delta for that node only', async () => {
        const h = harness();
        await h.registry.flushNow('mesh.status', 'c1', 'mesh:status:m1');
        const snapshot = h.frames[0]!;
        h.heads.n2 = 'ddd';
        await h.flush('m1');
        expect(h.frames).toHaveLength(2);
        const delta = h.frames[1]!.update;
        expect(delta).toMatchObject({ mode: 'delta', meshId: 'm1', seq: 2 });
        expect(Object.keys(delta.delta.collections)).toEqual(['nodes']);
        expect(delta.delta.collections.nodes.upsert).toEqual([
            { nodeId: 'n2', git: expect.objectContaining({ headCommit: 'ddd' }) },
        ]);
        expect(delta.delta.collections.nodes.removed).toBeUndefined();
        // Volatile stamps ride along only because something changed.
        expect(Object.keys(delta.delta.set ?? {}).sort()).toEqual(['refreshedAt', 'turnPresentationCounters']);
        expect(h.frames[1]!.bytes).toBeLessThan(snapshot.bytes / 3);
        // The fold of snapshot + delta equals the next full document (minus the stamps).
        const folded = foldKeyedDoc(snapshot.update.status, delta.delta, MESH_STATUS_DOC_SPEC) as any;
        expect(folded.nodes.map((n: any) => n.git.headCommit)).toEqual(['aaa', 'ddd', 'ccc']);
    });

    it('scopes a flush to the named mesh and serves every subscriber of it from ONE build', async () => {
        const h = harness();
        h.registry.subscribe('c2', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'mesh.status', key: 'mesh:status:m1', params: { meshId: 'm1' } });
        h.registry.subscribe('c3', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'mesh.status', key: 'mesh:status:m2', params: { meshId: 'm2' } });
        await h.flush('m1');
        expect(h.frames.map((f) => f.connectionId).sort()).toEqual(['c1', 'c2']);
        expect(h.builds()).toBe(1);
        expect(h.registry.meshStatusMeshIds().sort()).toEqual(['m1', 'm2']);
    });

    it('a failed send falls back to a snapshot; an empty meshId never subscribes', async () => {
        const h = harness();
        expect(h.registry.subscribe('c9', { type: 'subscribe', wireVersion: DASHBOARD_WIRE_VERSION, topic: 'mesh.status', key: 'k', params: { meshId: '  ' } })).toBe(false);
        await h.flush('m1');
        h.setDeliver(false);
        h.heads.n1 = 'zzz';
        await h.flush('m1');
        h.setDeliver(true);
        await h.flush('m1');
        expect(h.frames.map((f) => f.update.mode)).toEqual(['snapshot', 'snapshot']);
    });

    it('a flush requested while the same mesh is building runs once more after it, never concurrently', async () => {
        const h = harness();
        await h.flush('m1');
        const before = h.builds();
        await Promise.all([h.registry.flushMeshStatus('m1'), h.registry.flushMeshStatus('m1'), h.registry.flushMeshStatus('m1')]);
        expect(h.builds() - before).toBeLessThanOrEqual(2);
    });
});
