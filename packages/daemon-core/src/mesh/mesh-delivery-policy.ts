import { randomUUID } from 'crypto';
import {
    isBlockedStatus,
    isBusyStatus,
    isDeadStatus,
    isMeshDeliveryMode,
    normalizeSessionStatus,
    type MeshDeliveryMode,
} from '@adhdev/mesh-shared';
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
 * The vocabulary (`when_idle` | `interrupt`) is declared ONCE in
 * @adhdev/mesh-shared (`MESH_DELIVERY_MODES`, wiring-unification A3) and its
 * semantics — including why `interrupt` is deliberately blunt about discarding
 * the in-flight turn — are documented on that tuple. This policy, the MCP
 * schema and the daemon-core barrel all read the same list.
 */
export type { MeshDeliveryMode };

/** The delivery mode used when a caller does not specify one. Interrupting is
 *  always an explicit opt-in — never a default, never inferred. */
export const DEFAULT_DELIVERY_MODE: MeshDeliveryMode = 'when_idle';

/**
 * Normalize a caller-supplied delivery mode.
 *
 * Fail-closed on anything unrecognized: an unknown string falls back to
 * `when_idle` (the safe mode) AND reports that it did so, so a typo like
 * "immediate" can never be silently read as consent to destroy a running turn.
 */
export function normalizeDeliveryMode(
    raw: unknown,
): { mode: MeshDeliveryMode; unrecognized?: string } {
    if (raw === undefined || raw === null || raw === '') return { mode: DEFAULT_DELIVERY_MODE };
    const v = String(raw).trim().toLowerCase();
    // camelCase spelling of the default is tolerated; everything else must be a member.
    if (v === 'whenidle') return { mode: 'when_idle' };
    if (isMeshDeliveryMode(v)) return { mode: v };
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
 * Status classification (wiring-unification A3).
 *
 * "Busy" is no longer a hand-maintained local set (one of five that disagreed
 * with each other): it is `isBusyStatus` from mesh-shared — the `working` and
 * `blocked` classes of SESSION_STATUS_CLASS plus every alias spelling the class
 * map accepts. Mapping from the old sets to the outcome each spelling gets now:
 *
 *   immediate (unchanged) — 'idle' (the ready class member that means "will
 *     take input now") plus the two legacy spellings 'waiting_input' / 'ready'
 *     that only this policy ever accepted; they are not in the shared
 *     vocabulary, so they stay an explicit local set. The other ready-class
 *     members ('panel_hidden', 'not_monitored') were rejected before as
 *     unrecognized and STILL are: a task delivered to a session nobody is
 *     monitoring can never report completion, so they are deliberately not
 *     promoted to immediate here.
 *   queued (busy) — every spelling the old BUSY set carried ('generating',
 *     'running', 'streaming', 'busy', 'starting', 'initializing',
 *     'waiting_approval', 'waiting_choice') classifies working/blocked, PLUS the
 *     alias spellings the old set silently rejected ('finalizing', 'working',
 *     'loading', 'thinking', 'active', 'no_progress', 'long_generating',
 *     'waiting'). Those used to fall through to the fail-closed reject — a
 *     session that is demonstrably alive and mid-turn is queued, not refused.
 *   rejected (terminal) — the dead class ('stopped', 'error', 'disconnected';
 *     'disconnected' was previously rejected as unrecognized — same decision,
 *     now with the terminal reason) plus the legacy terminal spellings
 *     'failed' / 'terminated' / 'exited' / 'closed' / 'deleted', kept as an
 *     explicit set so their reason string stays `session_<status>_terminal`.
 *   rejected (unknown) — anything else, fail-closed, unchanged.
 */
const LEGACY_IMMEDIATE_DELIVERY_STATUSES: ReadonlySet<string> = new Set(['waiting_input', 'ready']);
const LEGACY_TERMINAL_DELIVERY_STATUSES: ReadonlySet<string> = new Set(['failed', 'terminated', 'exited', 'closed', 'deleted']);

function isImmediateDeliveryStatus(status: string): boolean {
    return normalizeSessionStatus(status) === 'idle' || LEGACY_IMMEDIATE_DELIVERY_STATUSES.has(status);
}

function isTerminalDeliveryStatus(status: string): boolean {
    return isDeadStatus(status) || LEGACY_TERMINAL_DELIVERY_STATUSES.has(status);
}

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
        deliveryMode?: MeshDeliveryMode;
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

    if (isImmediateDeliveryStatus(status)) {
        return {
            decision: 'immediate',
            reason: `session_${status}`,
            message: `Session is ${status} — delivery allowed immediately.`,
        };
    }

    if (isBusyStatus(status)) {
        if (opts?.allowBusyInjection) {
            return {
                decision: 'immediate',
                reason: `session_${status}_busy_injection_allowed`,
                message: `Session is ${status} but provider supports busy injection. Delivered immediately.`,
            };
        }
        // approval-kind may be delivered to sessions parked on a human decision.
        // `waiting_choice` (question picker) is the same shape as `waiting_approval`:
        // the session is blocked on a modal whose answer IS the delivery, so routing
        // it through the idle queue would deadlock — the session never goes idle
        // until someone answers.
        if (isBlockedStatus(status) && opts?.kind === 'approval') {
            return {
                decision: 'immediate',
                reason: `session_${status}_approval_message`,
                message: `Session is parked on a ${status === 'waiting_choice' ? 'choice' : 'approval'} prompt — answer delivered immediately.`,
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

    if (isTerminalDeliveryStatus(status)) {
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
