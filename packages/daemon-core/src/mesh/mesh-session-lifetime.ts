/** Fail-closed lifetime safety shared by idle reuse and reclamation. */
import { randomUUID } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import { afterBridgeCommit } from './worker-bridge-transaction.js';
import { isBusyStatus, isIdleSessionState, readText, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isWriterStopPending } from '../commands/mesh-writer-stop-journal.js';

export function isSafeIdleTaskSession(state: any, meta: Record<string, unknown> = {}): boolean {
    if (!state) return false;
    const settings = { ...meta, ...state.settings };
    const launches = [state.launchRecord, settings.launchRecord];
    if (launches.some(launch => launch?.spawnedForTaskId === null || launch?.launchedBy === 'assistant'
        || ['coordinator', 'assistant'].includes(launch?.roleLaunch?.role))) return false;
    const role = readText(settings.meshRole || settings.role || state.role).toLowerCase();
    if (settings.meshCoordinatorFor || settings.assistant || settings.isAssistant || state.assistant || state.isAssistant
        || readText(settings.launchedBy).toLowerCase() === 'assistant'
        || role === 'coordinator' || role === 'assistant' || settings.spawnedForTaskId === null
        || state.spawnedForTaskId === null || state.launchRecord?.spawnedForTaskId === null
        || state.launchRecord?.launchedBy === 'assistant' || (settings.launchRecord as any)?.launchedBy === 'assistant') return false;
    if (isBusyStatus(state.status) || isBusyStatus(state.activeChat?.status)) return false;
    if (state.activeModal || state.activeInteractivePrompt || state.pendingApproval || state.pendingPrompt
        || state.activeChat?.activeModal || state.activeChat?.activeInteractivePrompt) return false;
    return isIdleSessionState(state);
}

export const SESSION_COMPLETION_ACCEPTED_EVENT = 'session_lifetime_completion_accepted';

/** Only called at successful report returns, including duplicate and late acceptance.
 * Reuses the existing audit store; no queue/schema changes. Failed evidence writes
 * are visible and leave the TTL/cap backstops in place.
 */
export function recordAcceptedSessionCompletion(identity: { meshId: string; taskId: string; sessionId?: string; attemptId?: string }, nowMs: number): void {
    const store = MeshRuntimeStore.getInstance();
    afterBridgeCommit(store.db, () => {
        try {
            if (!identity.attemptId || !identity.sessionId) return;
            const recorded = store.turnStore().insertWorkerEvent({ eventId: randomUUID(), attemptId: identity.attemptId, sessionId: identity.sessionId,
                kind: SESSION_COMPLETION_ACCEPTED_EVENT, dedupeKey: 'accepted', payload: {}, atMs: nowMs });
            if (!recorded && !store.turnStore().listWorkerEventsForTask(identity.meshId, identity.taskId, SESSION_COMPLETION_ACCEPTED_EVENT)
                .some(event => event.attemptId === identity.attemptId && sessionIdsEquivalent(event.sessionId, identity.sessionId!))) {
                throw new Error('accepted_lifetime_audit_not_persisted');
            }
        } catch (error) {
            LOG.warn('MeshSessionLifetime', `Accepted report lifetime audit failed for task ${identity.taskId}: ${String(error)}; TTL/cap remain active`);
        }
    });
}

/** Immutable accepted output plus the audit marker for duplicate/late reports. */
export function acceptedCompletionSessionIds(meshId: string, tasks: any[]): Set<string> {
    const ids = new Set<string>();
    const store = MeshRuntimeStore.getInstance();
    for (const task of tasks) {
        if (!['completed', 'failed', 'blocked', 'cancelled'].includes(task.status)) continue;
        const turns = store.turnStore();
        const output = store.getLatestTaskOutput(task.id);
        const envelope = output ? JSON.parse(output.envelopeJson) : null;
        const candidates = envelope?.evidence?.summarySource === 'tool_report' && envelope.source?.session_id
            ? [{ sessionId: envelope.source.session_id, generation: null }]
            : turns.listWorkerEventsForTask(meshId, task.id, SESSION_COMPLETION_ACCEPTED_EVENT);
        for (const candidate of candidates) {
            const sessionId = candidate.sessionId;
            if (!sessionId) continue;
            const latest = turns.findPresentationAttemptForSession(sessionId)?.attempt;
            // Old accepted evidence cannot terminate a session handed to a newer turn.
            if (latest && (latest.meshId !== meshId || latest.taskId !== task.id || !latest.terminal
                || (candidate.generation !== null && candidate.generation !== latest.generation)
                || latest.state === 'stopping' || (latest.data.writerStop && latest.data.writerStop.confirmed !== true))) continue;
            ids.add(sessionId);
        }
    }
    return ids;
}

/** Includes pending writer checkpoints even after queue retirement. Unknown storage is fatal. */
export function sessionCheckpointPending(sessionId: string): boolean {
    if (isWriterStopPending(sessionId)) return true;
    const attempt = MeshRuntimeStore.getInstance().turnStore().findPresentationAttemptForSession(sessionId)?.attempt;
    return !!attempt && (!attempt.terminal || attempt.state === 'stopping' || !!attempt.data.writerStop && attempt.data.writerStop.confirmed !== true);
}

export function includesSession(ids: Set<string>, candidate: string): boolean {
    return [...ids].some(id => sessionIdsEquivalent(id, candidate));
}

export interface StopRetry { attempts: number; nextAt: number }
const retries = new Map<string, StopRetry>();
export function resetSessionStopRetries(): void { retries.clear(); }
export function sessionStopRetryDue(key: string, now: number): boolean { return (retries.get(key)?.nextAt ?? 0) <= now; }
export function recordSessionStopFailure(key: string, now: number): StopRetry {
    const attempts = (retries.get(key)?.attempts ?? 0) + 1;
    const retry = { attempts, nextAt: now + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5)) };
    retries.set(key, retry);
    return retry;
}
export function clearSessionStopRetry(key: string): void { retries.delete(key); }
