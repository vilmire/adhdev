// ---------------------------------------------------------------------------
// mesh-session-busy-dispatch — the typed SESSION-BUSY-WITH-TASK refusal contract
// ---------------------------------------------------------------------------
// preview rc.37: a second task's body was injected into a worker session that was
// still generating its FIRST task. The worker parked the body behind the running
// turn, executed it as turn 2, and — worse — `attachMeshAssignment` re-stamped the
// session's `meshActiveTaskId` / attempt markers from the live task to the new one,
// so every report the worker made about the task it was ACTUALLY running named the
// wrong task.
//
// The worker now refuses such a dispatch before anything is stamped or submitted
// (provider-instance-manager `attachMeshAssignmentToInstance`). This module is the
// single, dependency-free contract for that refusal, mirroring
// mesh-duplicate-dispatch.ts:
//
//   - in-process callers read the typed fields off `SessionBusyWithTaskError`;
//   - callers across the P2P + IPC hops only get the error MESSAGE (the IPC leg
//     keeps nothing else for a handler error), so the message carries one
//     machine-generated token `session_busy_with_task[task=<id> attempt=<id|->]`
//     that `classifySessionBusyWithTask` reads back. The token is produced and
//     consumed here only; no free text is interpreted.
//
// A refusal is a dispatch FAILURE for the dispatching side (nothing was delivered),
// never a delivery — the queue-claim funnel requeues it and the direct path records
// `dispatch_failed` against the attempt it opened.
// ---------------------------------------------------------------------------

/** Stable machine code for "this session is busy running a different task". */
export const SESSION_BUSY_WITH_TASK_CODE = 'session_busy_with_task';

/** What the refusal carries back to the dispatcher. */
export interface SessionBusyWithTaskInfo {
    /** The task the session is currently stamped with and running. */
    currentTaskId: string;
    /** That task's live attempt id on the worker, when known. */
    currentAttemptId?: string;
}

const TOKEN_RE = /session_busy_with_task\[task=([^\s\]]+) attempt=([^\s\]]+)\]/;

/** The machine token embedded in the refusal message (see header). */
export function formatSessionBusyWithTaskToken(info: SessionBusyWithTaskInfo): string {
    const attempt = typeof info.currentAttemptId === 'string' && info.currentAttemptId.trim() ? info.currentAttemptId.trim() : '-';
    return `${SESSION_BUSY_WITH_TASK_CODE}[task=${info.currentTaskId} attempt=${attempt}]`;
}

/** The error a worker throws when it refuses a dispatch onto a busy session. */
export class SessionBusyWithTaskError extends Error {
    readonly code = SESSION_BUSY_WITH_TASK_CODE;
    readonly reason = SESSION_BUSY_WITH_TASK_CODE;
    readonly currentTaskId: string;
    readonly currentAttemptId?: string;
    readonly incomingTaskId?: string;
    readonly sessionId?: string;

    constructor(info: SessionBusyWithTaskInfo & { incomingTaskId?: string; sessionId?: string }) {
        super(
            `Refusing mesh dispatch${info.incomingTaskId ? ` of task ${info.incomingTaskId}` : ''}: `
            + `session ${info.sessionId || '?'} is busy running task ${info.currentTaskId} `
            + `(${formatSessionBusyWithTaskToken(info)}). Nothing was stamped or submitted; `
            + 'retry once the session is idle or target another session.',
        );
        this.name = 'SessionBusyWithTaskError';
        this.currentTaskId = info.currentTaskId;
        if (info.currentAttemptId) this.currentAttemptId = info.currentAttemptId;
        if (info.incomingTaskId) this.incomingTaskId = info.incomingTaskId;
        if (info.sessionId) this.sessionId = info.sessionId;
    }
}

/**
 * Classify a dispatch failure as a session-busy refusal: the in-process error
 * object, or any string / error whose message carries the machine token.
 * Returns null for everything else.
 */
export function classifySessionBusyWithTask(err: unknown): SessionBusyWithTaskInfo | null {
    if (!err) return null;
    if (typeof err === 'object') {
        const e = err as { code?: unknown; currentTaskId?: unknown; currentAttemptId?: unknown };
        if (e.code === SESSION_BUSY_WITH_TASK_CODE && typeof e.currentTaskId === 'string' && e.currentTaskId) {
            return {
                currentTaskId: e.currentTaskId,
                ...(typeof e.currentAttemptId === 'string' && e.currentAttemptId ? { currentAttemptId: e.currentAttemptId } : {}),
            };
        }
    }
    const text = typeof err === 'string'
        ? err
        : (typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : (typeof (err as { error?: unknown }).error === 'string' ? (err as { error: string }).error : ''));
    const match = TOKEN_RE.exec(text);
    if (!match) return null;
    return {
        currentTaskId: match[1],
        ...(match[2] !== '-' ? { currentAttemptId: match[2] } : {}),
    };
}
