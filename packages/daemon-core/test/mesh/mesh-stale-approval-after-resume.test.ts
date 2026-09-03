/**
 * STALE-BLOCKED-AFTER-RESUME (live defect, 2026-09-02)
 *
 * mesh_list_pending_approvals kept returning a session as awaiting approval
 * long after the modal/question was resolved and the worker had resumed normal
 * work, with `waitingSince` pinned to the task's ORIGINAL DISPATCH time —
 * before the modal even existed.
 *
 * Two independent causes, both fixed here:
 *
 *  1. STATUS. `task_approval_needed` / `task_question_pending` are LEVEL
 *     assertions about a modal open at that instant, not true terminals like
 *     task_completed/task_failed. There is no `task_approval_resolved` ledger
 *     kind, so a worker that answers and keeps working emits nothing to
 *     supersede the blocked row — and `terminalStatus || live.status` let that
 *     stale row outrank a live session already back to `generating`.
 *
 *  2. WAITING-SINCE. The projection anchored to `dispatchedAt`, so the reported
 *     wait described the task's whole lifetime rather than the approval's.
 *
 * Impact was not cosmetic: a coordinator trusting the inbox calls mesh_approve
 * against a modal that no longer exists, injecting keys into a working session.
 *
 * The existing mesh-stale-approval-after-terminal.test.ts covers only the
 * after-a-real-terminal case; the resolved-and-STILL-RUNNING case was uncovered.
 */
import { describe, expect, it } from 'vitest'
import { buildMeshActiveWork, collectPendingApprovals } from '../../src/mesh/mesh-active-work.js'

const NODE_ID = 'node_worker'
const SESSION_ID = 'sess_worker'
const TASK_ID = 'task_resume'

const DISPATCH_AT = '2026-09-02T10:00:00.000Z'
const APPROVAL_AT = '2026-09-02T10:30:00.000Z'
const NOW = new Date('2026-09-02T10:41:00.000Z').getTime()

function ledger(kind: string, timestamp: string, extra: Record<string, unknown> = {}) {
    return {
        id: `${kind}-${timestamp}`,
        kind,
        timestamp,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-cli',
        payload: { taskId: TASK_ID, source: 'direct', via: 'mesh_dispatch_task', ...extra },
    } as any
}

/** One mesh node whose single session reports `status`. */
function nodes(status: string) {
    return [{
        id: NODE_ID,
        nodeId: NODE_ID,
        sessions: [{ id: SESSION_ID, status }],
    }] as any[]
}

function build(sessionStatus: string, entries: any[]) {
    return buildMeshActiveWork({
        meshId: 'mesh_test',
        queue: [] as any,
        ledgerEntries: entries,
        directDispatches: [] as any,
        nodes: nodes(sessionStatus),
        now: NOW,
    })
}

const DISPATCH_AND_APPROVAL = [
    ledger('task_dispatched', DISPATCH_AT),
    ledger('task_approval_needed', APPROVAL_AT),
]

describe('stale approval after the worker resumes', () => {
    it('drops the session from the approval inbox once the live session is generating again', () => {
        // The worker answered the modal and went back to work. No task_completed
        // is emitted — the turn is still running — so only the live status can
        // tell us the modal is gone.
        const { activeWork } = build('generating', DISPATCH_AND_APPROVAL)
        const record = activeWork.find(r => r.taskId === TASK_ID)

        expect(record?.status).toBe('generating')
        expect(collectPendingApprovals(activeWork)).toEqual([])
    })

    it('drops it once the live session is idle again (answered, turn finished quietly)', () => {
        const { activeWork } = build('idle', DISPATCH_AND_APPROVAL)
        expect(collectPendingApprovals(activeWork)).toEqual([])
    })

    it('a resolved QUESTION also leaves the inbox — via the terminal index, not the status guard', () => {
        // NOT a guard for the fix above: `task_question_pending` is never
        // indexed as a terminal on this path (the index admits only
        // TERMINAL_LEDGER_KINDS + task_approval_needed), so this case is
        // already carried by the live-status fallback and passes with or
        // without the blocked-level guard. Asserted so the end-state is pinned
        // and a future widening of the terminal index has to stay compatible.
        const { activeWork } = build('generating', [
            ledger('task_dispatched', DISPATCH_AT),
            ledger('task_question_pending', APPROVAL_AT),
        ])
        expect(activeWork.find(r => r.taskId === TASK_ID)?.status).toBe('generating')
        expect(collectPendingApprovals(activeWork)).toEqual([])
    })

    // ---- The blocked state must STILL be reported when it is real ----

    it('KEEPS a genuinely-blocked session in the inbox (live session still reports approval)', () => {
        const { activeWork } = build('awaiting_approval', DISPATCH_AND_APPROVAL)
        const approvals = collectPendingApprovals(activeWork)

        expect(approvals).toHaveLength(1)
        expect(approvals[0]).toMatchObject({ nodeId: NODE_ID, sessionId: SESSION_ID, status: 'awaiting_approval' })
    })

    it('KEEPS it when the live session status is unreadable (no live evidence the modal closed)', () => {
        // Session present but with a status this projection cannot classify —
        // absence of contradicting evidence must not clear a blocked row.
        const { activeWork } = buildMeshActiveWork({
            meshId: 'mesh_test',
            queue: [] as any,
            ledgerEntries: DISPATCH_AND_APPROVAL,
            directDispatches: [] as any,
            nodes: [{ id: NODE_ID, nodeId: NODE_ID, sessions: [{ id: SESSION_ID, status: 'something-unknown' }] }] as any,
            now: NOW,
        })
        expect(collectPendingApprovals(activeWork)).toHaveLength(1)
    })

    it('REGRESSION: a real terminal still wins over a live blocked sniff', () => {
        // Pre-existing APPROVAL-Q1-REALTIME behaviour: task_completed outranks
        // everything, even a live session still reporting a modal.
        const { activeWork } = build('awaiting_approval', [
            ledger('task_dispatched', DISPATCH_AT),
            ledger('task_approval_needed', APPROVAL_AT),
            ledger('task_completed', '2026-09-02T10:35:00.000Z'),
        ])
        expect(collectPendingApprovals(activeWork)).toEqual([])
    })

    it('anchors waitingSince to the approval event, not the original dispatch', () => {
        const { activeWork } = build('awaiting_approval', DISPATCH_AND_APPROVAL)
        const [approval] = collectPendingApprovals(activeWork)

        expect(approval.waitingSince).toBe(APPROVAL_AT)
        // 11 minutes blocked (10:30 → 10:41), NOT the 41 minutes since dispatch.
        expect(approval.waitingMs).toBe(11 * 60 * 1000)
    })
})
