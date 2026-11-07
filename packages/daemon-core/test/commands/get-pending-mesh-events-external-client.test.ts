import { afterEach, describe, expect, it } from 'vitest';
import { meshEventsHandlers } from '../../src/commands/high-family/mesh-events.js';
import {
    bindMeshNoticeRuntime,
    createTurnDeliverCounters,
    type MeshNoticeRuntime,
    type PendingCoordinatorNoticeWire,
} from '../../src/mesh/turn-ledger/deliver.js';

// NOTICE-THEFT (daemon half): what `get_pending_mesh_events` answers an MCP
// client that is NOT a PTY-hosted coordinator (no `selfCoordinatorInboxRead`).
// With a live CLI coordinator hosted here the notices belong to its cursor:
// empty + `deliveredByCursor`, nothing read or acked. Without one the client IS
// the MCP-only coordinator and receives (and acks) the no-coordinator backlog.

function fakeRuntime(hasLiveCliCoordinator: boolean) {
    let pending: PendingCoordinatorNoticeWire[] = [{
        eventId: 'n1', writer: 'w', seq: 1, meshId: 'm1', event: 'agent:generating_completed', notify: 'completed' as any,
        nodeLabel: 'node-0', coordinatorMessage: '[System] done', queuedAt: 1,
    }];
    const reads: Array<{ ack?: boolean }> = [];
    const runtime: MeshNoticeRuntime = {
        notify: () => ({ eventId: 'x', queued: true }),
        readNotices: (_meshId, opts = {}) => {
            reads.push(opts);
            const out = pending;
            if (opts.ack !== false) pending = [];
            return out;
        },
        controlNotices: () => ({ notices: [], take: () => false }),
        retract: () => 0,
        hasUndelivered: () => pending.length > 0,
        hasLiveCliCoordinator: () => hasLiveCliCoordinator,
        isSelfDaemon: (id) => id === 'daemon-A',
        replicationPending: () => false,
        counters: () => createTurnDeliverCounters(),
    };
    return { runtime, reads, pendingCount: () => pending.length };
}

const handler = meshEventsHandlers.get_pending_mesh_events;

describe('get_pending_mesh_events for a client without a coordinator session', () => {
    afterEach(() => bindMeshNoticeRuntime(null));

    it('live CLI coordinator hosted here: empty, deliveredByCursor, nothing claimed', async () => {
        const f = fakeRuntime(true);
        bindMeshNoticeRuntime(f.runtime);
        const res: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A' });
        expect(res).toMatchObject({ success: true, events: [], hasLiveCliCoordinator: true, deliveredByCursor: true });
        expect(f.reads).toEqual([]);
        expect(f.pendingCount()).toBe(1);
    });

    it('no CLI coordinator here: the no-coordinator backlog is returned and acked', async () => {
        const f = fakeRuntime(false);
        bindMeshNoticeRuntime(f.runtime);
        const res: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A' });
        expect(res.events.map((e: any) => e.eventId)).toEqual(['n1']);
        expect(res.hasLiveCliCoordinator).toBe(false);
        expect(f.pendingCount()).toBe(0);
        const again: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A' });
        expect(again.events).toEqual([]);
    });

    it('the PTY-hosted coordinator reading its own inbox (selfCoordinatorInboxRead) still gets them', async () => {
        const f = fakeRuntime(true);
        bindMeshNoticeRuntime(f.runtime);
        const res: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A', selfCoordinatorInboxRead: true, sessionId: 'coord-1' });
        expect(res.events.map((e: any) => e.eventId)).toEqual(['n1']);
        expect(f.reads[0]).toMatchObject({ ack: true, surfacedSessionId: 'coord-1' });
    });

    it('self read: claim mode is informational only with a live CLI coordinator; MCP-only claims everything', async () => {
        const live = fakeRuntime(true);
        bindMeshNoticeRuntime(live.runtime);
        await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A', selfCoordinatorInboxRead: true });
        expect(live.reads[0]).toMatchObject({ claim: 'informational' });
        const mcpOnly = fakeRuntime(false);
        bindMeshNoticeRuntime(mcpOnly.runtime);
        await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A', selfCoordinatorInboxRead: true });
        expect(mcpOnly.reads[0]!.claim).toBeUndefined();
    });

    it('every answer carries the quiet notice counters and worker signals — as state, never as events', async () => {
        const f = fakeRuntime(true);
        const stats = { since: 1, wakes: 4, delivered: { completed: 5 }, suppressed: { 'no_progress:attempt_terminal': 2 }, coalesced: 1 };
        const quiet = [{ signal: 'stalled' as const, sessionId: 's1', attemptId: 'a1', generation: 0, since: 2, quietSec: 300 }];
        bindMeshNoticeRuntime({ ...f.runtime, noticeStats: () => stats, quietWorkerSignals: () => quiet });
        const cursorOwned: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A' });
        expect(cursorOwned).toMatchObject({ deliveredByCursor: true, noticeStats: stats, quietWorkerSignals: quiet });
        const own: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A', selfCoordinatorInboxRead: true });
        expect(own).toMatchObject({ noticeStats: stats, quietWorkerSignals: quiet });
        // An empty mesh adds no fields.
        bindMeshNoticeRuntime({ ...f.runtime, noticeStats: () => null, quietWorkerSignals: () => [] });
        const none: any = await handler({} as any, { meshId: 'm1', coordinatorDaemonId: 'daemon-A', selfCoordinatorInboxRead: true });
        expect('noticeStats' in none).toBe(false);
        expect('quietWorkerSignals' in none).toBe(false);
    });
});
