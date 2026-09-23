// Test helper (C-W3): bind a notice runtime that CAPTURES coordinator notices
// (the replacement of peeking the deleted pending-events table). Dedupes on
// the same default eventId the real notifier uses, so "queued once" / "second
// emit is a duplicate" assertions keep their meaning.
import {
    bindMeshNoticeRuntime,
    createTurnDeliverCounters,
    defaultNoticeEventId,
    type CoordinatorNotice,
    type MeshNoticeRuntime,
    type PendingCoordinatorNoticeWire,
} from '../../src/mesh/turn-ledger/deliver.js';
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js';

/** The wire shape the MCP inbox / mesh_status surface, rendered like deliver time. */
export function toNoticeWire(n: CoordinatorNotice, seq: number): PendingCoordinatorNoticeWire {
    const metadataEvent = n.metadataEvent ?? {};
    const nodeLabel = n.nodeLabel ?? '';
    return {
        eventId: n.eventId ?? `notice-${seq}`,
        writer: 'w-test',
        seq,
        meshId: n.meshId,
        event: n.event,
        notify: 'mesh_event',
        nodeLabel,
        coordinatorMessage: n.coordinatorMessage
            ?? (buildMeshSystemMessage({ event: n.event, nodeLabel, metadataEvent, worktreeHasQueuedTask: n.worktreeHasQueuedTask === true }) || ''),
        queuedAt: n.queuedAt ?? Date.now(),
        ...(typeof metadataEvent.taskId === 'string' ? { taskId: metadataEvent.taskId } : {}),
        ...(n.nodeId ? { nodeId: n.nodeId } : {}),
        ...(n.workspace ? { workspace: n.workspace } : {}),
        ...(n.targetCoordinatorSessionId ? { targetCoordinatorSessionId: n.targetCoordinatorSessionId } : {}),
        metadataEvent,
    };
}

export interface NoticeCapture {
    notices: CoordinatorNotice[];
    /** Notices for one mesh (all when omitted), oldest first. */
    pending(meshId?: string): CoordinatorNotice[];
    /** Same as pending(), then forget them (the old drain). */
    drain(meshId?: string): CoordinatorNotice[];
    clear(): void;
    restore(): void;
}

export function captureNotices(opts: { now?: () => number; replicationPending?: (meshId: string) => boolean } = {}): NoticeCapture {
    const notices: CoordinatorNotice[] = [];
    const ids = new Set<string>();
    const now = opts.now ?? (() => Date.now());
    const runtime: MeshNoticeRuntime = {
        notify(notice) {
            const eventId = notice.eventId ?? defaultNoticeEventId(notice, notice.queuedAt ?? now());
            if (ids.has(eventId)) return { eventId, queued: false };
            ids.add(eventId);
            notices.push({ ...notice, eventId });
            return { eventId, queued: true };
        },
        readNotices(meshId, opts) {
            const selected = notices.filter((n) => n.meshId === meshId);
            const wire = selected.map((n) => toNoticeWire(n, notices.indexOf(n) + 1));
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
        replicationPending: (meshId) => opts.replicationPending?.(meshId) ?? false,
        counters: () => createTurnDeliverCounters(),
    };
    bindMeshNoticeRuntime(runtime);
    const select = (meshId?: string) => notices.filter((n) => !meshId || n.meshId === meshId);
    return {
        notices,
        pending: select,
        drain(meshId) {
            const out = select(meshId);
            for (const n of out) notices.splice(notices.indexOf(n), 1);
            return out;
        },
        clear() { notices.length = 0; ids.clear(); },
        restore() { bindMeshNoticeRuntime(null); },
    };
}
