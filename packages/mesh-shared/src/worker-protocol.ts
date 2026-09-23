/**
 * worker-protocol — what a delegated worker is told, and what it may call.
 *
 * Wiring-unification Phase F1 (docs/design/2026-09-23-wiring-unification.md §7b).
 *
 * Measured 2026-09-23 on the live preview ledger: 635 worker attempts in 14
 * days, 3 `report_completion` calls. The worker MCP was delivered to every
 * provider and never used, because nothing ever told the worker it existed —
 * the dispatched task body carried no instruction and the coordinator prompt
 * did not mention the worker tools at all. The only text a worker saw about
 * its tools was the tool description.
 *
 * This module is the single source for BOTH sides of that contract:
 *   - `WORKER_TOOLS` — exactly what `adhdev mcp --mode worker` advertises
 *     (a parity test in mcp-server pins ListTools to this tuple);
 *   - `renderWorkerProtocolFooter()` — the block appended to EVERY dispatched
 *     task body, so a worker learns the protocol from the task itself;
 *   - `renderCoordinatorWorkerSection()` — the matching paragraph the
 *     coordinator prompt carries, so the coordinator expects structured reports
 *     and stops polling for them.
 */

export const WORKER_TOOLS = [
    'report_completion',
    'progress_update',
    'peer_context_pull',
    'git_status',
    'git_log',
    'git_diff',
] as const

export type WorkerTool = typeof WORKER_TOOLS[number]

const WORKER_TOOL_SET: ReadonlySet<string> = new Set(WORKER_TOOLS)

export function isWorkerTool(value: unknown): value is WorkerTool {
    return typeof value === 'string' && WORKER_TOOL_SET.has(value)
}

/** Stable marker line so a body is never footered twice and tests can find it. */
export const WORKER_PROTOCOL_FOOTER_MARKER = '--- adhdev worker protocol ---'

export interface WorkerProtocolFooterInput {
    taskId?: string
    taskMode?: string
    difficulty?: string
    readonly?: boolean
    /** Number of handoff notes enclosed above the footer, when any. */
    enclosedHandoffNotes?: number
}

export function hasWorkerProtocolFooter(body: string): boolean {
    return typeof body === 'string' && body.includes(WORKER_PROTOCOL_FOOTER_MARKER)
}

/**
 * The protocol block appended to a dispatched task. Written for the model that
 * receives it: imperative, short, and explicit about what is NOT available so
 * the worker does not go looking for coordinator tools.
 */
export function renderWorkerProtocolFooter(input: WorkerProtocolFooterInput = {}): string {
    const lines: string[] = [WORKER_PROTOCOL_FOOTER_MARKER]
    const scope: string[] = []
    if (input.taskId) scope.push(`task ${input.taskId}`)
    if (input.taskMode) scope.push(`mode ${input.taskMode}`)
    if (input.difficulty) scope.push(`difficulty ${input.difficulty}`)
    if (input.readonly) scope.push('read-only')
    if (scope.length) lines.push(`You are a delegated worker (${scope.join(', ')}).`)
    else lines.push('You are a delegated worker.')
    lines.push(
        'When your work is finished, blocked, or has failed, call `report_completion` exactly once. '
            + 'Its `summary` is recorded verbatim as the authoritative record of this task — your terminal is not '
            + 'scraped for it — so state what you did, what you found, and where you left the branch.',
        'For work that runs longer than a few minutes, call `progress_update` at natural checkpoints so the '
            + 'coordinator can see you are alive without polling.',
        '`peer_context_pull` shows what sibling tasks in this mission have reported; `git_status` / `git_diff` / '
            + '`git_log` inspect your own workspace.',
        'You have no coordinator tools (no `mesh_*`) by design: do not enqueue, dispatch, or restart anything. '
            + 'If you need a decision from the coordinator, finish with `report_completion` and outcome `blocked`.',
    )
    if (input.enclosedHandoffNotes && input.enclosedHandoffNotes > 0) {
        lines.push(
            `The ${input.enclosedHandoffNotes} handoff note(s) above were written by agents who touched this code before you; `
                + 'honour their conflict guidance and add your own in `handoff_notes` when you report.',
        )
    }
    return lines.join('\n')
}

/**
 * Append the footer to a body that does not carry one yet. Idempotent.
 */
export function appendWorkerProtocolFooter(body: string, input: WorkerProtocolFooterInput = {}): string {
    if (hasWorkerProtocolFooter(body)) return body
    const trimmed = body.replace(/\s+$/, '')
    return `${trimmed}\n\n${renderWorkerProtocolFooter(input)}`
}

/**
 * The paragraph the COORDINATOR prompt carries about its workers. Kept next to
 * the footer so the two halves of the protocol cannot drift apart.
 */
export function renderCoordinatorWorkerSection(): string {
    return [
        '## Workers',
        '',
        `Every task you dispatch is delivered with a worker protocol footer. Workers hold exactly these tools: ${WORKER_TOOLS.map((tool) => `\`${tool}\``).join(', ')} — and no \`mesh_*\` tools.`,
        '- A worker finishes by calling `report_completion`; its structured report (outcome, summary, touched files, branch state, handoff notes) is what reaches you as the completion event. Read that report — do not re-derive the outcome from `mesh_read_chat` or the terminal unless the report is missing.',
        '- `progress_update` from a worker arrives as a lightweight progress note. Do NOT poll `mesh_status`, `mesh_view_queue` or `mesh_read_chat` to check on a running worker; completion, progress, blocked and failure all arrive as events.',
        '- To reach a busy worker mid-task use `mesh_notify_worker`: the memo is delivered on the worker\'s next tool call (or when it becomes idle). A worker that reports `blocked` is asking you for a decision — answer it with `mesh_send_task` to the same session.',
        '- `mesh_status` is for node health and capacity before delegating, never for progress.',
    ].join('\n')
}
