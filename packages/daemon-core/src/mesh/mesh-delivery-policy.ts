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
    | 'rejected';     // Session is terminal or unknown: cannot deliver

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
        const active = MeshRuntimeStore.getInstance().getActiveSessionDeliveries(meshId, sessionId);
        for (const delivery of active) {
            MeshRuntimeStore.getInstance().updateSessionDeliveryStatus(delivery.id, terminalStatus);
        }
    } catch { /* best-effort */ }
}
