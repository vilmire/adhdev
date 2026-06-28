/**
 * Session / command-payload record helpers for the mesh_* tools.
 *
 * Leaf module: depends on mesh-tool-shared (readString) and daemon-core's pure
 * isTaskReadonly predicate (for isWorkerTaskMode classification). Holds the shared
 * session-record readers/classifiers (id/provider/coordinator/unmanaged/terminal/
 * idle), the node session-id collector, and the command-payload unwrapper.
 * Physically split out of mesh-tools.ts (RF-SURVEY candidate C1) with no behavior
 * change — same function bodies. mesh-tools.ts and the queue/compact cluster files
 * import these back, so there is no runtime import cycle.
 */
import { readString } from './mesh-tool-shared.js';
import { isTaskReadonly } from '@adhdev/daemon-core';

export function readSessionRecordId(session: any): string | undefined {
    return readString(session?.id)
        || readString(session?.sessionId)
        || readString(session?.session_id)
        || readString(session?.runtimeSessionId)
        || readString(session?.runtime_session_id)
        || readString(session?.instanceId)
        || readString(session?.instance_id);
}

export function extractStatusMetadataSessions(value: any): any[] {
    const payload = unwrapCommandPayload(value);
    const status = payload?.status && typeof payload.status === 'object'
        ? payload.status
        : payload;
    return Array.isArray(status?.sessions) ? status.sessions : [];
}

export function resolveSessionProviderType(session: any): string {
    return readString(session?.providerType)
        || readString(session?.cliType)
        || readString(session?.agentType)
        || '';
}

export function isMeshCoordinatorSessionRecord(session: any): boolean {
    return Boolean(
        readString(session?.settings?.meshCoordinatorFor)
        || readString(session?.meta?.meshCoordinatorFor)
        || readString(session?.metadata?.meshCoordinatorFor)
        || readString(session?.meshCoordinatorFor),
    );
}

/**
 * Returns true when a session has no mesh delegation metadata at all — neither
 * meshNodeFor (worker) nor meshCoordinatorFor (coordinator).  Dispatching a
 * worker task to such a session is unsafe: the session may be the coordinator's
 * own CLI session (self-send risk), an unrelated session, or a stale record
 * whose providerSessionId now aliases the coordinator's transcript.
 *
 * The check intentionally fails closed: an explicit delegate session launched
 * via mesh_launch_session always carries meshNodeFor, so any safe target passes.
 */
export function isUnmanagedSessionRecord(session: any): boolean {
    const hasMeshNodeFor = Boolean(
        readString(session?.settings?.meshNodeFor)
        || readString(session?.meta?.meshNodeFor)
        || readString(session?.metadata?.meshNodeFor)
        || readString(session?.meshNodeFor),
    );
    if (hasMeshNodeFor) return false;
    if (isMeshCoordinatorSessionRecord(session)) return false;
    // launchedByCoordinator is set by the daemon when it auto-launches a worker
    // session in response to a queue task; treat it as a managed delegate.
    const launchedByCoordinator = Boolean(
        session?.settings?.launchedByCoordinator === true
        || session?.meta?.launchedByCoordinator === true
        || session?.launchedByCoordinator === true,
    );
    return !launchedByCoordinator;
}

/**
 * QUEUE-NODE-SERIALIZATION: a "worker task mode" is any task that is NOT read-only —
 * i.e. one that needs a visible worker session and the one-active-per-node isolation.
 * Delegates to daemon-core's single {@link isTaskReadonly} predicate so this boundary
 * stays in lock-step with the scheduler's classification (no duplicate inline copy).
 * `readonly` is the explicit boolean axis; live_debug_readonly remains an OR-fallback
 * inside the predicate.
 */
export function isWorkerTaskMode(taskMode: string | undefined, readonly?: boolean): boolean {
    return !isTaskReadonly({ readonly, taskMode });
}

function addSessionRecord(target: Set<string>, session: any): void {
    if (!session || typeof session !== 'object' || isTerminalSessionRecord(session)) return;
    const sessionId = readSessionRecordId(session);
    if (sessionId) target.add(sessionId);
}

export function collectNodeSessionIds(node: any): Set<string> {
    const sessions = new Set<string>();
    const sessionArrays = [
        node?.sessions,
        node?.activeSessions,
        node?.active_sessions,
        node?.lastProbe?.sessions,
        node?.last_probe?.sessions,
        node?.lastProbe?.status?.sessions,
        node?.last_probe?.status?.sessions,
    ];
    for (const value of sessionArrays) {
        if (Array.isArray(value)) value.forEach(session => addSessionRecord(sessions, session));
    }

    const sessionRecords = [
        node?.activeSession,
        node?.active_session,
        node?.currentSession,
        node?.current_session,
        node?.runtimeSession,
        node?.runtime_session,
        node?.session,
        node?.lastProbe?.activeSession,
        node?.last_probe?.active_session,
        node?.lastProbe?.currentSession,
        node?.last_probe?.current_session,
        node?.lastProbe?.session,
        node?.last_probe?.session,
    ];
    sessionRecords.forEach(session => addSessionRecord(sessions, session));
    return sessions;
}

export function unwrapCommandPayload(value: any): any {
    let current = value;
    const seen = new Set<any>();
    for (let depth = 0; depth < 8; depth += 1) {
        if (!current || typeof current !== 'object' || seen.has(current)) break;
        seen.add(current);

        const nested = current.result ?? current.payload;
        if (!nested || typeof nested !== 'object') break;
        current = nested;
    }
    return current;
}

export function isTerminalSessionRecord(session: any): boolean {
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const lifecycle = typeof session?.lifecycle === 'string' ? session.lifecycle.toLowerCase() : '';
    const state = typeof session?.state === 'string' ? session.state.toLowerCase() : '';
    return [status, lifecycle, state].some(value => ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(value));
}

export function isIdleSessionRecord(session: any): boolean {
    if (isTerminalSessionRecord(session)) return false;
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const chatStatus = typeof session?.activeChat?.status === 'string' ? session.activeChat.status.toLowerCase() : '';
    return status === 'idle' || chatStatus === 'waiting_input';
}
