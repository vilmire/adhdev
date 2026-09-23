// Test helper (C-W3): the pending-events queue is gone — producers write
// coordinator notices through `notifyMeshCoordinator` (turn.notify rows). This
// module binds a CAPTURING notice runtime on import and exposes the old peek /
// drain names over it, so a producer test keeps asserting "which notice, to
// which coordinator, with which text" without a ledger or a seqscribe node.
//
// Text: a notice without a pre-rendered `coordinatorMessage` is rendered here
// with the SAME builder the deliver cursor uses at deliver time
// (buildMeshSystemMessage via renderNotice's mesh_event branch).
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getMachineId } from '../../src/config/config.js';
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js';
import type { CoordinatorNotice } from '../../src/mesh/turn-ledger/deliver.js';
import { captureNotices, type NoticeCapture } from './notice-capture.js';

let capture: NoticeCapture = captureNotices();

/** Re-bind after a test unbound the runtime (vi.resetModules / afterEach restore). */
export function rebindPendingNotices(opts: Parameters<typeof captureNotices>[0] = {}): void {
    capture.restore();
    capture = captureNotices(opts);
}

export type PendingNotice = CoordinatorNotice & { coordinatorMessage: string; nodeLabel: string; metadataEvent: Record<string, unknown>; queuedAt: number };

function rendered(n: CoordinatorNotice): PendingNotice {
    const metadataEvent = n.metadataEvent ?? {};
    const nodeLabel = n.nodeLabel ?? '';
    const coordinatorMessage = n.coordinatorMessage
        ?? (buildMeshSystemMessage({ event: n.event, nodeLabel, metadataEvent, worktreeHasQueuedTask: n.worktreeHasQueuedTask === true }) || '');
    return { ...n, nodeLabel, metadataEvent, coordinatorMessage, queuedAt: n.queuedAt ?? Date.now() };
}

/**
 * A notice without an explicit target is addressed to the PRODUCING daemon
 * (the notifier stamps `targetDaemonId = ledger.selfDaemonId`) — the machine
 * id the test's config mock reports.
 */
function addressedTo(n: CoordinatorNotice, daemonId?: string | readonly string[]): boolean {
    if (!daemonId) return true;
    let target = n.targetCoordinatorDaemonId;
    if (!target) {
        try { target = getMachineId() || undefined; } catch { target = undefined; }
        if (!target) return true;
    }
    const ids = Array.isArray(daemonId) ? daemonId : [daemonId as string];
    return ids.some((id) => daemonIdsEquivalent(id, target!));
}

export function getPendingMeshCoordinatorEvents(meshId?: string, daemonId?: string | readonly string[]): PendingNotice[] {
    return capture.pending(meshId).filter((n) => addressedTo(n, daemonId)).map(rendered);
}

export function drainPendingMeshCoordinatorEvents(meshId?: string, daemonId?: string | readonly string[], opts?: { onlyEvents?: ReadonlySet<string> }): PendingNotice[] {
    const out = capture.pending(meshId).filter((n) => addressedTo(n, daemonId) && (!opts?.onlyEvents || opts.onlyEvents.has(n.event)));
    for (const n of out) capture.notices.splice(capture.notices.indexOf(n), 1);
    return out.map(rendered);
}

export function __clearMeshPendingEventsForTests(): void {
    capture.clear();
}

export function allCapturedNotices(): CoordinatorNotice[] {
    return capture.notices;
}
