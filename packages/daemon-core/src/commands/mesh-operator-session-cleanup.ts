/**
 * Operator cleanupMeshSessions expected-assignment stop/delete path.
 * Captures the exact assignment at selection and carries it through the host
 * stop_session_if_expected / delete_session_if_expected critical section —
 * never a last-read CAS before an async unconditional stop/delete.
 */
import { resolveHostBootId, stripCleanupAfterStopSideEffect } from '@adhdev/session-host-core';
import type { SessionCleanupExpectedAssignment } from '@adhdev/session-host-core';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import {
    captureCleanupExpectedFromHostRecord,
    reserveSessionStop,
    releaseSessionStop,
    markSessionStopSent,
    confirmSessionStop,
    clearSessionStopFence,
    abortSessionStopAfterHostRefusal,
    CLEANUP_HOST_REFUSAL_CODES,
    type SessionCleanupExpected,
} from '../mesh/mesh-session-stop-fence.js';

export type OperatorCleanupExpected = SessionCleanupExpected;

/** Minimal host control surface used by operator cleanup (avoids router import cycle). */
export interface OperatorCleanupHostControl {
    getDiagnostics?(payload?: object): Promise<{ hostBootId?: string; hostStartedAt?: number }>;
    resolveHostBootId?(): Promise<string | null> | string | null;
    stopSessionIfExpected?(
        sessionId: string,
        expected: SessionCleanupExpectedAssignment,
    ): Promise<{ lifecycle?: string } | null>;
    deleteSessionIfExpected?(
        sessionId: string,
        expected: SessionCleanupExpectedAssignment,
        opts?: { force?: boolean },
    ): Promise<{ sessionId: string; deleted: boolean; alreadyAbsent?: boolean } | null>;
}

async function resolveOperatorHostBootId(control: OperatorCleanupHostControl): Promise<string | null> {
    if (typeof control.resolveHostBootId === 'function') return control.resolveHostBootId();
    if (typeof control.getDiagnostics !== 'function') return null;
    try {
        const diagnostics = await control.getDiagnostics({});
        if (typeof diagnostics?.hostBootId === 'string' && diagnostics.hostBootId) return diagnostics.hostBootId;
        return resolveHostBootId({ hostStartedAt: diagnostics?.hostStartedAt ?? 0 });
    } catch {
        return null;
    }
}

function sanitizeOperatorCleanupError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? 'cleanup_unconfirmed');
    const stripped = stripCleanupAfterStopSideEffect(raw);
    if (CLEANUP_HOST_REFUSAL_CODES.has(stripped.code) || stripped.code === 'cleanup_session_still_running') {
        return stripped.code;
    }
    // Prefer delete-kind before generic Unsupported — production RPC is
    // "Unsupported session host request: delete_session_if_expected".
    if (raw.includes('delete_session_if_expected')) return 'cleanup_expected_delete_unsupported';
    if (raw.includes('Unsupported') || raw.includes('Unknown request') || raw.includes('stop_session_if_expected')) {
        return 'cleanup_expected_stop_unsupported';
    }
    return 'cleanup_unconfirmed';
}

/** Proven before-action host refusals — safe to drop the durable stop fence. */
function isProvenBeforeActionRefusal(error: unknown, code: string): boolean {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    if (stripCleanupAfterStopSideEffect(raw).afterStop) return false;
    return CLEANUP_HOST_REFUSAL_CODES.has(code) || code === 'cleanup_session_still_running';
}

export function captureOperatorCleanupExpected(
    hostBootId: string,
    record: { sessionId?: string; runtimeKey?: string; startedAt?: number; meta?: any },
): SessionCleanupExpected | null {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    if (!sessionId) return null;
    return captureCleanupExpectedFromHostRecord({ sessionId, hostBootId, record });
}

export async function resolveOperatorCleanupHostBootId(control: OperatorCleanupHostControl): Promise<string | null> {
    return resolveOperatorHostBootId(control);
}

/**
 * Stop only the captured expected incarnation/assignment at the host critical section.
 * On refusal/mismatch: retains the writer, does not fabricate success.
 */
export async function operatorStopSessionIfExpected(args: {
    control: OperatorCleanupHostControl;
    meshId: string;
    sessionId: string;
    expected: SessionCleanupExpectedAssignment;
    beforeHostStop?: () => Promise<void>;
}): Promise<{ success: true; expected: SessionCleanupExpectedAssignment }
    | { success: false; error: string; retained: true }> {
    const { control, meshId, sessionId, expected } = args;
    if (typeof control.stopSessionIfExpected !== 'function') {
        return { success: false, error: 'cleanup_expected_stop_unsupported', retained: true };
    }
    const db = MeshRuntimeStore.getInstance().db;
    const stopId = reserveSessionStop(db, meshId, sessionId, undefined, expected);
    try {
        if (args.beforeHostStop) await args.beforeHostStop();
        markSessionStopSent(db, sessionId, stopId);
        try {
            const stopped = await control.stopSessionIfExpected(sessionId, expected);
            if (!stopped || (stopped.lifecycle !== 'stopped' && stopped.lifecycle !== 'stopping')) {
                return { success: false, error: 'cleanup_unconfirmed', retained: true };
            }
            confirmSessionStop(db, sessionId, stopId);
            return { success: true, expected };
        } catch (error) {
            const code = sanitizeOperatorCleanupError(error);
            if (isProvenBeforeActionRefusal(error, code) || code === 'cleanup_expected_stop_unsupported') {
                abortSessionStopAfterHostRefusal(db, sessionId, stopId);
            }
            return { success: false, error: code, retained: true };
        }
    } finally {
        releaseSessionStop(db, sessionId, stopId);
    }
}

/**
 * Delete only when the host still holds the exact stopped/selected incarnation.
 * Must not delete a newly replaced/reassigned record after the stop await.
 *
 * Force-delete (stop_and_delete) reserves the durable stop fence across the host
 * runtime.stop()/waitForRuntimeExit await and the post-await delete CAS so
 * claim/reuse/sendinput stay refused while the writer may already be dying.
 */
export async function operatorDeleteSessionIfExpected(args: {
    control: OperatorCleanupHostControl;
    meshId?: string;
    sessionId: string;
    expected: SessionCleanupExpectedAssignment;
    force?: boolean;
    beforeHostDelete?: () => Promise<void>;
}): Promise<{ success: true; deleted: true; alreadyAbsent?: boolean }
    | { success: false; error: string; retained: true }> {
    const { control, sessionId, expected } = args;
    if (typeof control.deleteSessionIfExpected !== 'function') {
        return { success: false, error: 'cleanup_expected_delete_unsupported', retained: true };
    }

    const force = args.force === true;
    const fenceMeshId = typeof args.meshId === 'string' && args.meshId ? args.meshId : null;
    // Force-delete awaits host stop — hold the same durable fence as mode=stop.
    if (force && fenceMeshId) {
        const db = MeshRuntimeStore.getInstance().db;
        const stopId = reserveSessionStop(db, fenceMeshId, sessionId, undefined, expected);
        try {
            if (args.beforeHostDelete) await args.beforeHostDelete();
            markSessionStopSent(db, sessionId, stopId);
            try {
                const result = await control.deleteSessionIfExpected(sessionId, expected, { force: true });
                if (!result || result.deleted !== true) {
                    return { success: false, error: 'cleanup_unconfirmed', retained: true };
                }
                // Proven delete removes the incarnation — clear fence (do not leave a
                // stop tombstone that would poison a later claim on the same sessionId).
                clearSessionStopFence(db, sessionId, stopId);
                return { success: true, deleted: true, ...(result.alreadyAbsent ? { alreadyAbsent: true } : {}) };
            } catch (error) {
                const code = sanitizeOperatorCleanupError(error);
                // Unsupported delete: no host mutation — keep fence for same-tuple
                // conditional-stop fallback (caller). Proven before-action refusal may abort.
                if (isProvenBeforeActionRefusal(error, code)) {
                    abortSessionStopAfterHostRefusal(db, sessionId, stopId);
                }
                return { success: false, error: code, retained: true };
            }
        } finally {
            releaseSessionStop(db, sessionId, stopId);
        }
    }

    try {
        if (args.beforeHostDelete) await args.beforeHostDelete();
        const result = await control.deleteSessionIfExpected(sessionId, expected, { force });
        if (!result || result.deleted !== true) {
            return { success: false, error: 'cleanup_unconfirmed', retained: true };
        }
        return { success: true, deleted: true, ...(result.alreadyAbsent ? { alreadyAbsent: true } : {}) };
    } catch (error) {
        return { success: false, error: sanitizeOperatorCleanupError(error), retained: true };
    }
}

export type OperatorCleanupMode = 'stop' | 'delete_stopped' | 'stop_and_delete';

export type OperatorCleanupModeOutcome =
    | { kind: 'stopped' }
    | { kind: 'deleted' }
    | { kind: 'skipped' }
    | { kind: 'refused'; error: string }
    | { kind: 'delete_unsupported'; stopped?: true };

/** Apply expected-assignment stop/delete for one matched operator-cleanup session. */
export async function applyOperatorSessionCleanupMode(args: {
    control: OperatorCleanupHostControl;
    meshId: string;
    sessionId: string;
    record: { sessionId?: string; runtimeKey?: string; startedAt?: number; meta?: any };
    hostBootId: string;
    mode: OperatorCleanupMode;
    completed: boolean;
    dryRun: boolean;
    markIntentionalStop: (action: 'stop_session' | 'delete_session_force') => Promise<void>;
}): Promise<OperatorCleanupModeOutcome> {
    const { control, meshId, sessionId, mode, completed, dryRun } = args;
    const expected = dryRun ? null : captureOperatorCleanupExpected(args.hostBootId, args.record);

    if (mode === 'stop') {
        if (completed) return { kind: 'skipped' };
        if (!dryRun) {
            if (!expected) return { kind: 'refused', error: 'cleanup_expected_malformed' };
            const stopped = await operatorStopSessionIfExpected({
                control, meshId, sessionId, expected,
                beforeHostStop: () => args.markIntentionalStop('stop_session'),
            });
            if (!stopped.success) return { kind: 'refused', error: stopped.error };
        }
        return { kind: 'stopped' };
    }

    if (mode === 'delete_stopped') {
        if (!completed) return { kind: 'skipped' };
        if (!dryRun) {
            if (!expected) return { kind: 'refused', error: 'cleanup_expected_malformed' };
            const deleted = await operatorDeleteSessionIfExpected({ control, sessionId, expected, force: false });
            if (!deleted.success) {
                if (deleted.error === 'cleanup_expected_delete_unsupported') return { kind: 'delete_unsupported' };
                return { kind: 'refused', error: deleted.error };
            }
        }
        return { kind: 'deleted' };
    }

    // stop_and_delete — production SessionHostController always exposes
    // deleteSessionIfExpected; old hosts refuse via RPC Unsupported. Fence the
    // force-delete await; unsupported delete may fall back ONLY to conditional
    // stop_session_if_expected under the same expected tuple + durable fence.
    if (!dryRun) {
        if (!expected) return { kind: 'refused', error: 'cleanup_expected_malformed' };
        if (typeof control.deleteSessionIfExpected === 'function') {
            const deleted = await operatorDeleteSessionIfExpected({
                control,
                meshId,
                sessionId,
                expected,
                force: true,
                beforeHostDelete: completed ? undefined : () => args.markIntentionalStop('delete_session_force'),
            });
            if (deleted.success) return { kind: 'deleted' };
            if (deleted.error === 'cleanup_expected_delete_unsupported') {
                if (!completed) {
                    const stopped = await operatorStopSessionIfExpected({
                        control, meshId, sessionId, expected,
                        beforeHostStop: () => args.markIntentionalStop('stop_session'),
                    });
                    if (!stopped.success) return { kind: 'refused', error: stopped.error };
                    return { kind: 'delete_unsupported', stopped: true };
                }
                return { kind: 'delete_unsupported' };
            }
            return { kind: 'refused', error: deleted.error };
        }
        // Method absent (non-production stubs only): stop-only soft fallback.
        if (!completed) {
            const stopped = await operatorStopSessionIfExpected({
                control, meshId, sessionId, expected,
                beforeHostStop: () => args.markIntentionalStop('stop_session'),
            });
            if (!stopped.success) return { kind: 'refused', error: stopped.error };
            return { kind: 'delete_unsupported', stopped: true };
        }
        return { kind: 'delete_unsupported' };
    }
    if (!completed) await args.markIntentionalStop('delete_session_force');
    return { kind: 'deleted' };
}

/** Old-host delete unsupported fallback: stop-if-expected only, never unconditional stop. */
export async function operatorCleanupDeleteUnsupportedFallback(args: {
    control: OperatorCleanupHostControl;
    meshId: string;
    sessionId: string;
    record: { sessionId?: string; runtimeKey?: string; startedAt?: number; meta?: any };
    hostBootId: string;
    mode: OperatorCleanupMode;
    completed: boolean;
    markIntentionalStop: (action: 'stop_session' | 'delete_session_force') => Promise<void>;
}): Promise<OperatorCleanupModeOutcome> {
    if (args.mode === 'stop_and_delete' && !args.completed) {
        const expected = captureOperatorCleanupExpected(args.hostBootId, args.record);
        if (!expected) return { kind: 'refused', error: 'cleanup_expected_malformed' };
        const stopped = await operatorStopSessionIfExpected({
            control: args.control, meshId: args.meshId, sessionId: args.sessionId, expected,
            beforeHostStop: () => args.markIntentionalStop('stop_session'),
        });
        if (!stopped.success) return { kind: 'refused', error: stopped.error };
        return { kind: 'delete_unsupported', stopped: true };
    }
    return { kind: 'delete_unsupported' };
}
