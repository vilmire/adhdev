/**
 * WORKER-MCP LOW family — the daemon side of the worker reporting tools.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §4 (B), §5 (C), §9.1.1.
 *
 * ─── Why these live in the DAEMON and not in the MCP server ──────────────
 *
 * The mcp-server process cannot do this work itself, for two independent
 * reasons, and both are structural rather than stylistic:
 *
 *  1. **The ledger.** `mesh_turn_events` and the turn reducer live in the
 *     daemon's SQLite store. Two processes writing terminal outcomes would mean
 *     two reducers, which is exactly the "two truths" the single-terminal-writer
 *     rule exists to prevent.
 *  2. **seqscribe.** `~/.adhdev/seqscribe.db` is held under a single-owner
 *     `BEGIN EXCLUSIVE` lock by the daemon; a second opener gets `ERR_DB_OWNED`.
 *     The mcp-server's seqscribe node is permanently null, so it could not
 *     append a handoff note even if it wanted to (design §9.1.1).
 *
 * ∴ the worker's report travels worker → (stdio) → mcp-server → (IPC) → daemon,
 * and the daemon is the only writer. This is the same conclusion decision F
 * reached independently for the proxy-append rule.
 *
 * ─── Authentication ─────────────────────────────────────────────────────
 *
 * Every handler here is fail-closed on identity. The caller presents a bind (or
 * a token); the daemon resolves it against state only the daemon has. Nothing
 * the caller asserts about WHICH task it is working on is trusted — there is no
 * `taskId` argument on purpose, because an argument can be wrong and a lookup
 * cannot (design §4: "워커가 taskId 를 인자로 넣지 않는다").
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const workerReportHandlers: Record<string, LowFamilyHandler> = {
    /**
     * Exchange a session bind for the caller's current task identity.
     *
     * Exposed as its own command so the MCP server can answer "do I have a task
     * right now" — which is what decides whether it publishes the reporting
     * tools at all — without having to submit a report to find out.
     *
     * ★The task TOKEN is deliberately NOT returned. The caller does not need it:
     * it presents the bind again on the actual report, and the daemon re-resolves.
     * Returning the token would put a second live secret on the wire for no gain.
     */
    worker_resolve_task: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { resolveWorkerIdentity } = await import('../../mesh/worker-report.js');
            const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
            if (!identity) {
                return {
                    success: false,
                    error: 'worker_not_bound',
                    hint: 'No live task is bound to this worker session. A report is only possible while a task is assigned.',
                };
            }
            return {
                success: true,
                meshId: identity.meshId,
                taskId: identity.taskId,
                ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
                ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /**
     * Accept a structured completion report.
     *
     * Validation errors come back as a STRUCTURED list rather than a single
     * string so the MCP layer can hand the worker something it can act on
     * field-by-field — the retry loop is the whole reason the schema is enforced
     * at the tool layer instead of being parsed out of prose.
     */
    worker_report_completion: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { validateWorkerCompletionReport, acceptWorkerCompletionReport } =
                await import('../../mesh/worker-report.js');
            const { report, errors } = validateWorkerCompletionReport(args?.report);
            if (!report) {
                return { success: false, error: 'invalid_report', validationErrors: errors };
            }
            const result = acceptWorkerCompletionReport({ token: args?.token, bind: args?.bind }, report);
            if (!result.accepted) {
                return {
                    success: false,
                    error: result.refusal,
                    ...(result.detail ? { detail: result.detail } : {}),
                    hint: result.refusal === 'unauthenticated'
                        ? 'No live task is bound to this worker session — the task may already be terminal or reassigned.'
                        : 'The completion was refused by the turn ledger; the task state is authoritative.',
                };
            }
            return {
                success: true,
                taskId: result.taskId,
                ...(result.attemptId ? { attemptId: result.attemptId } : {}),
                outcome: result.outcome,
                duplicate: result.duplicate,
                handoffNoteRecorded: result.handoffNoteRecorded,
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },

    /** Record a mid-task progress note. Never terminal. */
    worker_progress_update: async (_ctx: LowFamilyContext, args: any) => {
        const note = typeof args?.note === 'string' ? args.note.trim() : '';
        if (!note) return { success: false, error: 'note required' };
        try {
            const { acceptWorkerProgressUpdate } = await import('../../mesh/worker-report.js');
            const result = acceptWorkerProgressUpdate({ token: args?.token, bind: args?.bind }, note);
            if (!result.accepted) {
                return { success: false, error: result.refusal || 'unauthenticated' };
            }
            return { success: true, ...(result.taskId ? { taskId: result.taskId } : {}) };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};
