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
    /** Legacy-host fallback only (see legacyVerifiedStop): list the host's records / stop by id. */
    listSessions?(): Promise<any[]>;
    stopSession?(sessionId: string): Promise<any>;
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

const STOPPED_LIFECYCLES = new Set(['stopped', 'failed', 'interrupted']);
export const LEGACY_STOP_POLL_MS = 250;
export const LEGACY_STOP_TIMEOUT_MS = 5_000;
/** `ADHDEV_LEGACY_STOP_TIMEOUT_MS` shortens the proof wait (tests, tuning). */
function proofTimeoutMs(explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const raw = Number(process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 0 && process.env.ADHDEV_LEGACY_STOP_TIMEOUT_MS ? raw : LEGACY_STOP_TIMEOUT_MS;
}

/**
 * Recovery text for a refused cleanup/stop, naming what the operator can actually do next. The codes are
 * the machine contract; this is what a coordinator or dashboard shows. It never suggests Ctrl-C/ESC: those
 * keys are behind the destructive double gate (mesh_send_keys) and are not a session-stop mechanism.
 */
export function describeCleanupRecovery(error: string): string | undefined {
    switch (error) {
        case 'cleanup_expected_stop_unsupported':
            return 'The session host that runs this session predates exact-stop support and the safe fallback was not applicable '
                + '(name the session explicitly in session_ids, and it must be idle or waiting on approval/quota with no task generating). '
                + 'Otherwise restart that machine\'s session host (a daemon restart alone does not replace it) or close the CLI yourself, then re-run the cleanup to confirm. '
                + 'Do not use Ctrl-C/ESC keys to stop it. The session stays owned and fenced until a stop is proven.';
        case 'cleanup_stop_not_proven':
            return 'The stop was sent but the host still lists this exact session as running. Ownership stays fenced (no second writer can start). '
                + 'Re-run mesh_cleanup_sessions(mode: "stop") to re-check, or close the CLI process manually; handover continues once the host reports it stopped.';
        case 'cleanup_legacy_stop_session_active':
            return 'The session is generating a turn, so the legacy-host fallback refuses to stop it. Wait for it to go idle, or answer its pending prompt first.';
        case 'cleanup_assignment_mismatch':
        case 'cleanup_native_incarnation_mismatch':
            return 'The session changed after it was selected (new task or restarted CLI). Re-read the node state and decide again; nothing was stopped.';
        case 'cleanup_host_boot_mismatch':
            return 'The session host restarted since selection. Re-run the cleanup; nothing was stopped.';
        default:
            return undefined;
    }
}

/**
 * Wait until the host no longer lists THIS incarnation as live: absent, a different incarnation (runtimeKey/
 * startedAt differ) or a stopped lifecycle. Returns false when the deadline passes first — the caller must then
 * keep ownership fenced and say so; "stopping" is not a proof.
 */
export async function awaitSessionStopProof(args: {
    control: Pick<OperatorCleanupHostControl, 'listSessions'>;
    sessionId: string;
    expected: Pick<SessionCleanupExpectedAssignment, 'runtimeKey' | 'startedAt'>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<boolean> {
    if (typeof args.control.listSessions !== 'function') return false;
    const deadline = Date.now() + proofTimeoutMs(args.timeoutMs);
    const pollMs = args.pollMs ?? LEGACY_STOP_POLL_MS;
    for (;;) {
        try {
            const record = (await args.control.listSessions()).find(r => r?.sessionId === args.sessionId);
            if (!record) return true;
            const sameIncarnation = (args.expected.runtimeKey === undefined || record.runtimeKey === args.expected.runtimeKey)
                && (args.expected.startedAt === undefined || record.startedAt === args.expected.startedAt);
            if (!sameIncarnation || STOPPED_LIFECYCLES.has(String(record.lifecycle))) return true;
        } catch { /* host busy: keep polling until the deadline */ }
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
}

/**
 * Stop a session on a host that predates stop_session_if_expected. The host cannot compare-and-stop, so the
 * daemon re-verifies, immediately before the stop, everything the host would have: same host boot, same
 * incarnation and assignment tuple, still running, and (caller-supplied) not generating a turn. The durable
 * stop fence is already held, so claim/reuse/send-input stay refused across the remaining window. The stop is
 * then PROVEN by polling; anything short of that is a failure that keeps the fence.
 */
async function legacyVerifiedStop(args: {
    control: OperatorCleanupHostControl;
    sessionId: string;
    expected: SessionCleanupExpectedAssignment;
    sessionActive: boolean;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string; mutated: boolean }> {
    const { control, sessionId, expected } = args;
    if (typeof control.listSessions !== 'function' || typeof control.stopSession !== 'function') {
        return { ok: false, error: 'cleanup_expected_stop_unsupported', mutated: false };
    }
    if (args.sessionActive) return { ok: false, error: 'cleanup_legacy_stop_session_active', mutated: false };
    const bootId = await resolveOperatorHostBootId(control);
    if (!bootId || bootId !== expected.hostBootId) return { ok: false, error: 'cleanup_host_boot_mismatch', mutated: false };
    const record = (await control.listSessions()).find(r => r?.sessionId === sessionId);
    if (!record) return { ok: true };
    const current = captureOperatorCleanupExpected(bootId, record);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
        return { ok: false, error: 'cleanup_assignment_mismatch', mutated: false };
    }
    if (STOPPED_LIFECYCLES.has(String(record.lifecycle))) return { ok: true };
    if (record.lifecycle !== 'running') return { ok: false, error: 'cleanup_session_not_running', mutated: false };
    try {
        await control.stopSession(sessionId);
    } catch {
        // The RPC outcome is ambiguous (the host may have acted): fall through to the proof.
    }
    const proven = await awaitSessionStopProof({ control, sessionId, expected, timeoutMs: args.timeoutMs, pollMs: args.pollMs });
    return proven ? { ok: true } : { ok: false, error: 'cleanup_stop_not_proven', mutated: true };
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
    /** Legacy-host fallback gate: set by the caller only for an explicitly named session. */
    legacyHostStop?: { allow: boolean; sessionActive: boolean; timeoutMs?: number; pollMs?: number };
}): Promise<{ success: true; expected: SessionCleanupExpectedAssignment; legacyHostStop?: true }
    | { success: false; error: string; retained: true }> {
    const { control, meshId, sessionId, expected } = args;
    const legacy = args.legacyHostStop;
    const legacyAvailable = legacy?.allow === true && typeof control.stopSession === 'function' && typeof control.listSessions === 'function';
    if (typeof control.stopSessionIfExpected !== 'function' && !legacyAvailable) {
        return { success: false, error: 'cleanup_expected_stop_unsupported', retained: true };
    }
    const db = MeshRuntimeStore.getInstance().db;
    const stopId = reserveSessionStop(db, meshId, sessionId, undefined, expected);
    // Returns undefined when the legacy path does not apply (caller keeps the original refusal).
    const runLegacy = async (): Promise<{ success: true; expected: SessionCleanupExpectedAssignment; legacyHostStop: true }
        | { success: false; error: string; retained: true } | undefined> => {
        if (!legacyAvailable) return undefined;
        const outcome = await legacyVerifiedStop({ control, sessionId, expected, sessionActive: legacy!.sessionActive, timeoutMs: legacy!.timeoutMs, pollMs: legacy!.pollMs });
        if (outcome.ok) {
            confirmSessionStop(db, sessionId, stopId);
            return { success: true, expected, legacyHostStop: true };
        }
        // Before-action refusals prove no mutation: drop the fence. An unproven stop keeps it.
        if (!outcome.mutated) abortSessionStopAfterHostRefusal(db, sessionId, stopId);
        return { success: false, error: outcome.error, retained: true };
    };
    try {
        if (args.beforeHostStop) await args.beforeHostStop();
        markSessionStopSent(db, sessionId, stopId);
        if (typeof control.stopSessionIfExpected !== 'function') {
            return await runLegacy() ?? { success: false, error: 'cleanup_expected_stop_unsupported', retained: true };
        }
        try {
            const stopped = await control.stopSessionIfExpected(sessionId, expected);
            if (!stopped || (stopped.lifecycle !== 'stopped' && stopped.lifecycle !== 'stopping')) {
                return { success: false, error: 'cleanup_unconfirmed', retained: true };
            }
            confirmSessionStop(db, sessionId, stopId);
            return { success: true, expected };
        } catch (error) {
            const code = sanitizeOperatorCleanupError(error);
            if (code === 'cleanup_expected_stop_unsupported') {
                const fallback = await runLegacy();
                if (fallback) return fallback;
            }
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
    legacyHostStop?: { allow: boolean; sessionActive: boolean; timeoutMs?: number; pollMs?: number };
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
                legacyHostStop: args.legacyHostStop,
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
                        legacyHostStop: args.legacyHostStop,
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
                legacyHostStop: args.legacyHostStop,
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
