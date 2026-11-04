/**
 * Usage limit -> the owner picks another CLI -> the old session is PROVEN stopped -> the task's context is
 * preserved -> it resumes on the other CLI (mission ac0a8f3a).
 *
 * Every step reuses an existing, separately guarded path; this module only fixes their ORDER so that no
 * second writer can start before the first is gone:
 *
 *   1. validate   the task is assigned to exactly this session and the destination is a different provider
 *                 (the caller supplies the owner's approval; nothing here decides to switch by itself);
 *   2. stop       operator cleanup, mode 'stop', the session NAMED explicitly: exact-assignment host stop,
 *                 with the bounded legacy-host fallback + stop proof (mesh-operator-session-cleanup.ts). The
 *                 session record and its chat stay (no delete), so nothing it produced is lost;
 *   3. requeue    only after the stop is proven: the same task row goes back to pending with a continuation
 *                 note (original instruction + where the prior session's work and history live) and the
 *                 provider pin REPLACED for this one task — no global slot, node policy or other task's pin
 *                 changes;
 *   4. the normal claim/auto-launch path starts the destination CLI on the same node.
 *
 * Failure at step 2 leaves the task assigned and the session fenced (ownership is released only on a proven
 * stop) and returns a concrete recovery message. Failure at step 3 (the turn ledger still holds an open
 * attempt) leaves the proven-stopped session as is; the ledger settles on its own writer-absent evidence.
 * A second call for the same task while one runs, or after it finished, is refused.
 */
import { LOG } from '../logging/logger.js';
import { describeCleanupRecovery } from '../commands/mesh-operator-session-cleanup.js';
import { meshRecord } from './mesh-record.js';
import { getQueueEntryById, requeueTaskWithOutcome } from './mesh-work-queue.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export interface QuotaProviderSwitchDeps {
    /** Does the session host still list this session? `false` = it is gone (deleted/never restored): nothing to stop, ownership can move. */
    hostHasSession?(sessionId: string): Promise<boolean>;
    cleanupMeshSessions(args: {
        meshId: string; nodeId: string; node: any; mode: 'stop'; sessionIds: string[]; source: 'mesh_cleanup_sessions';
    }): Promise<{ success: boolean; stoppedSessionIds?: string[]; errors?: Array<{ sessionId: string; error: string; recovery?: string }>; [key: string]: unknown }>;
}

export interface QuotaProviderSwitchArgs {
    meshId: string;
    nodeId: string;
    node: any;
    taskId: string;
    /** The exhausted session being replaced. */
    sessionId: string;
    fromProvider: string;
    toProvider: string;
    /** Who approved the switch; only an owner-originated request may replace a provider pin. */
    approvedBy: 'owner';
}

export type QuotaProviderSwitchResult =
    | { ok: true; taskId: string; stoppedSessionId: string; toProvider: string; stopProof: 'proven' }
    | { ok: false; phase: 'validate' | 'stop' | 'requeue'; code: string; error: string; recovery?: string };

const inFlight = new Set<string>();

function fail(phase: 'validate' | 'stop' | 'requeue', code: string, error: string, recovery?: string): QuotaProviderSwitchResult {
    return { ok: false, phase, code, error, ...(recovery ? { recovery } : {}) };
}

function continuationNote(original: string, a: QuotaProviderSwitchArgs): string {
    return `${original}\n\n[Continuation] The previous session ${a.sessionId} (${a.fromProvider}) reached its usage limit and was stopped on node ${a.nodeId}; `
        + `the owner moved this task to ${a.toProvider}. Its work so far is in the node workspace (check git status/diff first) and its chat history is still readable `
        + `with mesh_read_chat on that session id. Continue from there; do not redo finished work.`;
}

export async function switchQuotaExhaustedSession(deps: QuotaProviderSwitchDeps, a: QuotaProviderSwitchArgs): Promise<QuotaProviderSwitchResult> {
    if (a.approvedBy !== 'owner') return fail('validate', 'owner_approval_required', 'only an owner-approved request may replace a provider');
    if (!a.toProvider || a.toProvider === a.fromProvider) return fail('validate', 'same_provider', 'choose a different provider than the exhausted one');
    const key = `${a.meshId}:${a.taskId}`;
    if (inFlight.has(key)) return fail('validate', 'switch_in_progress', 'a provider switch for this task is already running');
    inFlight.add(key);
    try {
        const task = getQueueEntryById(a.meshId, a.taskId);
        if (!task) return fail('validate', 'task_not_found', `no queue task '${a.taskId}'`);
        if (task.status !== 'assigned' || task.assignedSessionId !== a.sessionId) {
            return fail('validate', 'task_not_owned_by_session', 'the task is not assigned to that session (already moved, finished or cancelled); nothing was stopped');
        }
        // DELETED-SESSION CASE: the task is still assigned to a session the host no longer has (deleted by hand or
        // lost on restart). There is nothing left to stop and no second writer can appear from it, so the reassignment
        // is allowed on the host's own "absent" answer - never on a stop that did not happen.
        const gone = deps.hostHasSession ? !(await deps.hostHasSession(a.sessionId).catch(() => true)) : false;
        const stop = gone
            ? { success: true, stoppedSessionIds: [a.sessionId] as string[] }
            : await deps.cleanupMeshSessions({
                meshId: a.meshId, nodeId: a.nodeId, node: a.node, mode: 'stop', sessionIds: [a.sessionId], source: 'mesh_cleanup_sessions',
            });
        const stopped = stop.success && (stop.stoppedSessionIds ?? []).includes(a.sessionId);
        if (!stopped) {
            const err = (stop as { errors?: Array<{ sessionId: string; error: string; recovery?: string }> }).errors?.find(e => e.sessionId === a.sessionId);
            const code = err?.error ?? (stop.success ? 'cleanup_unconfirmed' : String((stop as { error?: unknown }).error ?? 'cleanup_unconfirmed'));
            meshRecord(a.meshId, 'quota_provider_switch', { nodeId: a.nodeId, sessionId: a.sessionId, taskId: a.taskId,
                payload: { phase: 'stop_refused', code, fromProvider: a.fromProvider, toProvider: a.toProvider } }, { local: true });
            return fail('stop', code, `the exhausted ${a.fromProvider} session was not proven stopped (${code}); it stays the task's owner`,
                err?.recovery ?? describeCleanupRecovery(code));
        }
        const outcome = requeueTaskWithOutcome(a.meshId, a.taskId, {
            reason: `quota_provider_switch:${a.fromProvider}->${a.toProvider}`,
            clearTargetSession: true,
            force: true,
            message: continuationNote(task.message, a),
        });
        if (!outcome) return fail('requeue', 'task_not_found', 'the task disappeared while the session was stopping');
        if (outcome.refusal) {
            return fail('requeue', outcome.refusal.reason, `the old session is stopped but the task cannot be reopened yet (${outcome.refusal.reason})`,
                'The turn ledger still holds an open attempt for the stopped session; it settles on its own writer-absent evidence. Re-run the switch afterwards - the stop is already proven.');
        }
        // Replace the provider pin for THIS task only (the owner chose the destination).
        const store = MeshRuntimeStore.getInstance();
        store.transaction(() => {
            const row = store.findQueueEntryById(a.meshId, a.taskId);
            if (!row || row.status !== 'pending') return;
            row.requiredTags = [...(row.requiredTags ?? []).filter(tag => !tag.startsWith('provider=')), `provider=${a.toProvider}`];
            delete row.hold; delete row.holdNoticeId; delete row.autoLaunch;
            store.updateQueueEntry(row);
        });
        meshRecord(a.meshId, 'quota_provider_switch', { nodeId: a.nodeId, sessionId: a.sessionId, taskId: a.taskId,
            payload: { phase: 'requeued', fromProvider: a.fromProvider, toProvider: a.toProvider, approvedBy: a.approvedBy } }, { local: true });
        return { ok: true, taskId: a.taskId, stoppedSessionId: a.sessionId, toProvider: a.toProvider, stopProof: 'proven' };
    } catch (e: any) {
        LOG.warn('MeshQueue', `quota provider switch for task ${a.taskId} failed: ${e?.message || e}`);
        return fail('stop', 'switch_failed', String(e?.message || e));
    } finally {
        inFlight.delete(key);
    }
}
