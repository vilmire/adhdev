// Test helper (C integration): the daemon's pending-events queue is gone —
// producers write coordinator notices through `notifyMeshCoordinator`
// (turn.notify rows on a booted daemon). An mcp-server test process has no
// booted daemon, so this module binds a CAPTURING notice runtime on the SAME
// `@adhdev/daemon-core` instance the tools under test import (the dist barrel —
// daemon-core's own test/helpers/pending-notices.ts binds the src instance,
// which mcp-server code never sees) and exposes the old peek / drain / clear
// names over it.
//
// The capture dedupes on the real notifier's default eventId, and `readNotices`
// answers `get_pending_mesh_events` for an in-process fake transport.
import {
    bindMeshNoticeRuntime,
    createTurnDeliverCounters,
    defaultNoticeEventId,
    type CoordinatorNotice,
    type MeshNoticeRuntime,
    type PendingCoordinatorNoticeWire,
} from '@adhdev/daemon-core';

const notices: CoordinatorNotice[] = [];
const ids = new Set<string>();

function toWire(n: CoordinatorNotice, seq: number): PendingCoordinatorNoticeWire {
    const metadataEvent = n.metadataEvent ?? {};
    return {
        eventId: n.eventId ?? `notice-${seq}`,
        writer: 'w-test',
        seq,
        meshId: n.meshId,
        event: n.event,
        notify: 'mesh_event',
        nodeLabel: n.nodeLabel ?? '',
        coordinatorMessage: n.coordinatorMessage ?? '',
        queuedAt: n.queuedAt ?? Date.now(),
        ...(typeof metadataEvent.taskId === 'string' ? { taskId: metadataEvent.taskId } : {}),
        ...(n.nodeId ? { nodeId: n.nodeId } : {}),
        ...(n.workspace ? { workspace: n.workspace } : {}),
        ...(n.targetCoordinatorSessionId ? { targetCoordinatorSessionId: n.targetCoordinatorSessionId } : {}),
        metadataEvent,
    };
}

const runtime: MeshNoticeRuntime = {
    notify(notice) {
        const eventId = notice.eventId ?? defaultNoticeEventId(notice, notice.queuedAt ?? Date.now());
        if (ids.has(eventId)) return { eventId, queued: false };
        ids.add(eventId);
        notices.push({ ...notice, eventId });
        return { eventId, queued: true };
    },
    readNotices(meshId, opts) {
        const selected = notices.filter((n) => n.meshId === meshId);
        const wire = selected.map((n) => toWire(n, notices.indexOf(n) + 1));
        if (opts?.ack !== false) for (const n of selected) notices.splice(notices.indexOf(n), 1);
        return wire;
    },
    controlNotices: () => ({ notices: [], take: () => false }),
    retract(meshId, match) {
        let n = 0;
        for (let i = notices.length - 1; i >= 0; i--) {
            const notice = notices[i]!;
            if (notice.meshId === meshId && match(notice.event, notice.metadataEvent ?? {})) { notices.splice(i, 1); n++; }
        }
        return n;
    },
    hasUndelivered: (meshId) => notices.some((n) => n.meshId === meshId),
    hasLiveCliCoordinator: () => false,
    isSelfDaemon: () => true,
    replicationPending: () => false,
    counters: () => createTurnDeliverCounters(),
};

bindMeshNoticeRuntime(runtime);

/** Re-bind after a test unbound the runtime. */
export function rebindPendingNotices(): void {
    bindMeshNoticeRuntime(runtime);
}

/** Captured notices for one mesh (all when omitted), oldest first. */
export function getPendingMeshCoordinatorEvents(meshId?: string): CoordinatorNotice[] {
    return notices.filter((n) => !meshId || n.meshId === meshId);
}

/** Same as get, then forget them (the old drain). */
export function drainPendingMeshCoordinatorEvents(meshId?: string): CoordinatorNotice[] {
    const out = getPendingMeshCoordinatorEvents(meshId);
    for (const n of out) notices.splice(notices.indexOf(n), 1);
    return out;
}

export function __clearMeshPendingEventsForTests(_meshId?: string): void {
    notices.length = 0;
    ids.clear();
}

export function allCapturedNotices(): CoordinatorNotice[] {
    return notices;
}
