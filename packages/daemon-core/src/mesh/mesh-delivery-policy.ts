import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

/**
 * Possible delivery statuses for a session delivery record.
 */
export type MeshSessionDeliveryStatus =
    | 'queued'
    | 'delivering'
    | 'delivered'
    | 'acked'
    | 'completed'
    | 'failed'
    | 'expired'
    | 'cancelled';

/**
 * Kind of delivery — controls priority and policy handling.
 */
export type MeshSessionDeliveryKind =
    | 'task'
    | 'followup'
    | 'approval'
    | 'recovery'
    | 'system_notice';

/**
 * A session delivery decision — what to do when a task arrives for a session.
 */
export type MeshDeliveryDecision =
    | 'immediate'     // Session is idle: deliver now, create an 'acked' delivery record
    | 'queued'        // Session is busy: hold delivery until session becomes idle
    | 'interrupt'     // Session is busy and the caller asked to ABORT the running turn first
    | 'rejected';     // Session is terminal or unknown: cannot deliver

/**
 * How the caller wants a task delivered to a session that may be busy.
 *
 *   'when_idle'  — DEFAULT. Never disturbs a running turn. A busy session's task
 *                  is queued and auto-delivered on its next idle transition.
 *   'interrupt'  — Abort the turn currently in flight (press the provider's own
 *                  stop control), then deliver the new task once the session
 *                  settles to idle.
 *
 * ★ The name is deliberately blunt. This is NOT "inject alongside the current
 * work" — the in-flight turn is CANCELLED and whatever it had not yet finished
 * is LOST. `immediate` was rejected as a name precisely because it reads like a
 * gentle overlay; a caller skimming the option list must be able to tell from
 * the word alone that work gets thrown away.
 */
export type MeshTaskDeliveryMode = 'when_idle' | 'interrupt';

/** The delivery mode used when a caller does not specify one. Interrupting is
 *  always an explicit opt-in — never a default, never inferred. */
export const DEFAULT_DELIVERY_MODE: MeshTaskDeliveryMode = 'when_idle';

/**
 * Normalize a caller-supplied delivery mode.
 *
 * Fail-closed on anything unrecognized: an unknown string falls back to
 * `when_idle` (the safe mode) AND reports that it did so, so a typo like
 * "immediate" can never be silently read as consent to destroy a running turn.
 */
export function normalizeDeliveryMode(
    raw: unknown,
): { mode: MeshTaskDeliveryMode; unrecognized?: string } {
    if (raw === undefined || raw === null || raw === '') return { mode: DEFAULT_DELIVERY_MODE };
    const v = String(raw).trim().toLowerCase();
    if (v === 'when_idle' || v === 'whenidle') return { mode: 'when_idle' };
    if (v === 'interrupt') return { mode: 'interrupt' };
    return { mode: DEFAULT_DELIVERY_MODE, unrecognized: String(raw) };
}

export interface MeshDeliveryPolicyResult {
    decision: MeshDeliveryDecision;
    reason: string;
    /** When decision='queued', estimated deliver-after ISO timestamp if known. */
    deliverAfter?: string;
    /** Human-readable explanation for coordinator/operator. */
    message: string;
}

/**
 * Session statuses where immediate delivery is allowed.
 * The session is ready to accept new work.
 */
const IMMEDIATE_DELIVERY_STATUSES = new Set([
    'idle',
    'waiting_input',
    'ready',
]);

/**
 * Session statuses that indicate the session is busy but still alive.
 * Delivery is queued rather than attempted immediately.
 */
const BUSY_DELIVERY_STATUSES = new Set([
    'generating',
    'running',
    'streaming',
    'busy',
    'starting',
    'initializing',
    'waiting_approval',
]);

/**
 * Session statuses that indicate the session is permanently unavailable.
 * Delivery should be rejected.
 */
const TERMINAL_DELIVERY_STATUSES = new Set([
    'stopped',
    'failed',
    'terminated',
    'exited',
    'closed',
    'deleted',
    'error',
]);

/**
 * Determine whether to deliver immediately, queue, or reject based on session status.
 *
 * This is a pure function — it does not write to any store.
 */
export function resolveDeliveryDecision(
    sessionStatus: string | undefined,
    opts?: {
        kind?: MeshSessionDeliveryKind;
        /** When true, busy session immediate injection is allowed (provider-specific capability). */
        allowBusyInjection?: boolean;
        /**
         * Caller's requested delivery mode. Defaults to 'when_idle'.
         * 'interrupt' asks to abort the in-flight turn before delivering.
         */
        deliveryMode?: MeshTaskDeliveryMode;
        /**
         * Whether the target provider can actually interrupt a turn, resolved
         * from its live spec (resolveInterruptCapability). REQUIRED to get an
         * 'interrupt' decision: when the caller asks to interrupt a provider
         * that cannot, we return 'rejected' rather than quietly degrading to
         * 'queued'. A silent downgrade would tell the caller its steering
         * landed while the session actually ran to completion on the old
         * instructions — the same "success signal != reality" failure this
         * whole feature exists to avoid.
         */
        interruptSupported?: boolean;
        /** Why interrupt is unavailable, surfaced verbatim to the operator. */
        interruptUnsupportedMessage?: string;
    },
): MeshDeliveryPolicyResult {
    const status = (sessionStatus || '').trim().toLowerCase();

    if (!status) {
        return {
            decision: 'rejected',
            reason: 'unknown_session_status',
            message: 'Session status is unknown. Delivery rejected (fail-closed). Use mesh_launch_session to start a fresh session.',
        };
    }

    if (IMMEDIATE_DELIVERY_STATUSES.has(status)) {
        return {
            decision: 'immediate',
            reason: `session_${status}`,
            message: `Session is ${status} — delivery allowed immediately.`,
        };
    }

    if (BUSY_DELIVERY_STATUSES.has(status)) {
        if (opts?.allowBusyInjection) {
            return {
                decision: 'immediate',
                reason: `session_${status}_busy_injection_allowed`,
                message: `Session is ${status} but provider supports busy injection. Delivered immediately.`,
            };
        }
        // approval-kind may be delivered to waiting_approval sessions
        if (status === 'waiting_approval' && opts?.kind === 'approval') {
            return {
                decision: 'immediate',
                reason: 'session_waiting_approval_approval_message',
                message: 'Session is waiting for approval — approval message delivered immediately.',
            };
        }
        // ── Explicit interrupt request ────────────────────────────────────────
        // Only reached when the caller opted in via deliveryMode:'interrupt'.
        // The default path below is untouched.
        if (opts?.deliveryMode === 'interrupt') {
            if (!opts.interruptSupported) {
                // ★ REJECT, never silently fall back to 'queued'. The caller asked to
                // change a running session's trajectory; queueing would instead let the
                // current turn finish on the OLD instructions and deliver afterwards —
                // a materially different outcome. Reporting that as success is the
                // defect class this feature exists to eliminate, so we fail loudly and
                // let the caller choose when_idle deliberately.
                return {
                    decision: 'rejected',
                    reason: 'interrupt_unsupported_for_provider',
                    message: opts.interruptUnsupportedMessage
                        ?? `Session is ${status} and delivery mode 'interrupt' was requested, but this provider cannot interrupt a running turn. `
                            + 'Refusing rather than silently queueing: queueing would let the current turn finish on the old instructions. '
                            + "Re-dispatch with delivery mode 'when_idle' if delivery-after-completion is acceptable.",
                };
            }
            return {
                decision: 'interrupt',
                reason: `session_${status}_interrupt_requested`,
                message: `Session is ${status}. Aborting the in-flight turn via the provider's stop control, then delivering the task once it settles to idle. `
                    + 'The work the session had not yet finished is discarded.',
            };
        }
        return {
            decision: 'queued',
            reason: `session_${status}_busy`,
            message: `Session is ${status}. Task queued for delivery when session becomes idle. Do not inject directly into a busy session.`,
        };
    }

    if (TERMINAL_DELIVERY_STATUSES.has(status)) {
        return {
            decision: 'rejected',
            reason: `session_${status}_terminal`,
            message: `Session is ${status} (terminal). Delivery rejected. Launch a new session before dispatching tasks.`,
        };
    }

    // Unknown/unrecognized status: fail-closed
    return {
        decision: 'rejected',
        reason: 'unrecognized_session_status',
        message: `Session status '${sessionStatus}' is not recognized. Delivery rejected (fail-closed). Inspect session state before retrying.`,
    };
}

export interface SessionDeliveryRecord {
    id: string;
    meshId: string;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    kind: MeshSessionDeliveryKind;
    priority: number;
    message: string;
    status: MeshSessionDeliveryStatus;
    deliverAfter?: string;
    expiresAt?: string;
    attemptCount: number;
    sourceCoordinatorSessionId?: string;
    sourceCoordinatorDaemonId?: string;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Create a delivery record in the store.
 */
export function createSessionDelivery(opts: {
    meshId: string;
    nodeId?: string;
    sessionId?: string;
    providerType?: string;
    taskId?: string;
    kind: MeshSessionDeliveryKind;
    message: string;
    status: MeshSessionDeliveryStatus;
    priority?: number;
    deliverAfter?: string;
    expiresAt?: string;
    sourceCoordinatorSessionId?: string;
    sourceCoordinatorDaemonId?: string;
}): SessionDeliveryRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: SessionDeliveryRecord = {
        id,
        meshId: opts.meshId,
        nodeId: opts.nodeId,
        sessionId: opts.sessionId,
        providerType: opts.providerType,
        taskId: opts.taskId,
        kind: opts.kind,
        priority: opts.priority ?? 0,
        message: opts.message,
        status: opts.status,
        deliverAfter: opts.deliverAfter,
        expiresAt: opts.expiresAt,
        attemptCount: 0,
        sourceCoordinatorSessionId: opts.sourceCoordinatorSessionId,
        sourceCoordinatorDaemonId: opts.sourceCoordinatorDaemonId,
        createdAt: now,
        updatedAt: now,
    };
    MeshRuntimeStore.getInstance().insertSessionDelivery({
        id,
        meshId: opts.meshId,
        nodeId: opts.nodeId,
        sessionId: opts.sessionId,
        providerType: opts.providerType,
        taskId: opts.taskId,
        kind: opts.kind,
        priority: opts.priority ?? 0,
        message: opts.message,
        status: opts.status,
        deliverAfter: opts.deliverAfter,
        expiresAt: opts.expiresAt,
        sourceCoordinatorSessionId: opts.sourceCoordinatorSessionId,
        sourceCoordinatorDaemonId: opts.sourceCoordinatorDaemonId,
        createdAt: now,
        updatedAt: now,
    });
    return record;
}

/**
 * Update the status of a delivery record.
 */
export function updateSessionDeliveryStatus(
    id: string,
    status: MeshSessionDeliveryStatus,
    opts?: { lastError?: string; incrementAttempt?: boolean },
): void {
    try {
        MeshRuntimeStore.getInstance().updateSessionDeliveryStatus(id, status, opts);
    } catch { /* best-effort */ }
}

/**
 * Get active (non-terminal) deliveries for a mesh, optionally filtered by session.
 */
export function getActiveSessionDeliveries(meshId: string, sessionId?: string) {
    try {
        return MeshRuntimeStore.getInstance().getActiveSessionDeliveries(meshId, sessionId);
    } catch {
        return [];
    }
}

/**
 * DELIVERED-NOT-CONSUMED-REDRIVE consume path. Advance a task's delivery record(s) to a
 * CONSUMED status ('acked'/'completed') by (mesh, session[, task]), INCLUDING rows already in
 * 'delivered' — unlike getActiveSessionDeliveries which excludes 'delivered'. The store's
 * monotonic guard only ever advances the row. Returns the number of rows advanced.
 */
export function consumeSessionDelivery(
    meshId: string,
    sessionId: string,
    status: 'acked' | 'completed',
    taskId?: string,
): number {
    try {
        return MeshRuntimeStore.getInstance().consumeSessionDelivery(meshId, sessionId, status, taskId);
    } catch {
        return 0;
    }
}

// MESH-COMPLEXITY-AUDIT Part 8-2: the completion-conflict diagnostic
// (recordCompletionConflict / getRecentCompletionConflicts, backed by
// mesh_completion_conflicts) was dropped. It recorded WHICH task lost a
// fingerprint-dedup collision but had no production reader and no role in the
// no-loss delivery contract — the dedup DECISION lives entirely in the
// fingerprint match in mesh-event-forwarding.ts, which is unchanged. Removing
// the side-record does not alter any completion-delivery outcome.

export function __clearSessionDeliveriesForTests(meshId: string): void {
    MeshRuntimeStore.getInstance().deleteSessionDeliveries(meshId);
}

/**
 * Mark all active (queued/delivering/delivered/acked) deliveries for a session as completed or failed.
 * Called when a task's terminal status is confirmed so delivery records stay in sync.
 */
export function markSessionDeliveriesTerminal(
    meshId: string,
    sessionId: string,
    terminalStatus: 'completed' | 'failed',
): void {
    try {
        // Route through markOpenSessionDeliveriesTerminal, which matches OPEN rows including
        // 'delivered' — getActiveSessionDeliveries EXCLUDES 'delivered' and would silently
        // leave the common (already-delivered) row un-terminated, keeping taskDeliveryConsumed()
        // false and feeding the delivered_not_consumed_redrive false re-drive.
        MeshRuntimeStore.getInstance().markOpenSessionDeliveriesTerminal(meshId, sessionId, terminalStatus);
    } catch { /* best-effort */ }
}
