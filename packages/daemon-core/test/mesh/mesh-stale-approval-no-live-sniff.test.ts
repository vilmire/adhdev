/**
 * STALE-APPROVAL-NO-LIVE-SNIFF (live defect, 2026-09-12)
 *
 * A worker session that had finished and gone idle kept being reported as
 * `awaiting_approval` — on mesh_status, and (the surface the owner actually saw)
 * on the `[Mesh] active N: 1 awaiting_approval` line appended to coordinator
 * notifications. A coordinator trusting it was repeatedly about to fire
 * mesh_approve at a modal that no longer existed.
 *
 * WHY THE EXISTING GUARD DID NOT CATCH IT. mesh-stale-approval-after-resume
 * added a contradiction guard: for the LEVEL kinds (task_approval_needed /
 * task_question_pending), a live-session status that is not itself blocked wins
 * over the stale ledger row. But that guard requires `live.status`, which comes
 * from `sessionStatusFromNodes(opts.nodes, ...)` — and two of the five
 * buildMeshActiveWork call sites passed NO `nodes` at all before this fix:
 *
 *   - mesh-notification-status-line.ts (buildMeshStatusLineForNotification)
 *   - mesh-idle-reminder.ts
 *
 * On those surfaces `live.status` is ALWAYS undefined, so the guard is
 * structurally dead and nothing could ever retire the row.
 *
 * WHAT WAS ALREADY COVERED. A task's OWN terminal does retire it: the snapshot
 * matcher prefers a real terminal over an approval for the same dispatch, and
 * such records leave activeWork as terminal rows. The uncovered shape is an
 * approval task with no own terminal whose SESSION demonstrably moved on — a
 * later task on the same session completed/failed, or the session itself stopped.
 *
 * THE FIX. Session-scoped ledger evidence as a SECONDARY contradiction, used
 * only when the live sniff produced nothing. It mirrors the already-shipped
 * real-time equivalent for approval NUDGES (isApprovalNudgeResolved in
 * mesh-reconcile-coordinator-drain.ts), tightened from that guard's
 * `nodeMatch || sessionMatch` to session-only — node-wide matching would let an
 * unrelated task finishing anywhere on the node retire a genuinely-blocked
 * session's approval.
 *
 * The second half of this file is the reverse regression: over-retirement would
 * mean silently dropping a REAL approval, which is strictly worse than showing a
 * stale one. Every condition that must NOT retire is pinned.
 */
import { describe, expect, it } from 'vitest'
import { buildMeshActiveWork, collectPendingApprovals } from '../../src/mesh/mesh-active-work.js'
import { buildMeshStatusLineForNotification, renderMeshStatusLine } from '../../src/mesh/mesh-notification-status-line.js'
import { __clearMeshLedgerForTests, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js'
import { __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const NODE_ID = 'node_worker'
const SESSION_ID = 'sess_worker'
const TASK_ID = 'task_blocked'
const FOLLOW_UP_TASK_ID = 'task_next'

const DISPATCH_AT = '2026-09-12T10:00:00.000Z'
const APPROVAL_AT = '2026-09-12T10:30:00.000Z'
const TERMINAL_AT = '2026-09-12T10:35:00.000Z'
const RESOLVED_AT = '2026-09-12T10:31:00.000Z'
const NOW = new Date('2026-09-12T10:41:00.000Z').getTime()

function ledger(
    kind: string,
    timestamp: string,
    extra: Record<string, unknown> = {},
    sessionId: string = SESSION_ID,
) {
    return {
        id: `${kind}-${timestamp}-${extra.taskId ?? TASK_ID}`,
        kind,
        timestamp,
        nodeId: NODE_ID,
        sessionId,
        providerType: 'claude-cli',
        payload: { taskId: TASK_ID, source: 'direct', via: 'mesh_dispatch_task', ...extra },
    } as any
}

/**
 * Build with NO `nodes` — reproducing the notification-status-line / idle-reminder
 * call sites exactly. This is the condition under which the live-sniff guard is dead.
 */
function buildWithoutLiveSniff(entries: any[], queue: any[] = []) {
    return buildMeshActiveWork({
        meshId: 'mesh_test',
        queue,
        ledgerEntries: entries,
        directDispatches: [] as any,
        now: NOW,
    })
}

function renderBannerSnapshot(built: ReturnType<typeof buildWithoutLiveSniff>) {
    return renderMeshStatusLine({
        activeWork: built.activeWork,
        statusCounts: built.summary.statusCounts,
        totalActiveCount: built.summary.totalActiveCount,
    })
}

function queueRow(taskId: string, status: 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled') {
    return {
        id: taskId,
        meshId: 'mesh_test',
        message: 'direct dispatch awaiting approval',
        status,
        assignedNodeId: NODE_ID,
        assignedSessionId: SESSION_ID,
        createdAt: DISPATCH_AT,
        updatedAt: TERMINAL_AT,
        dispatchTimestamp: DISPATCH_AT,
    } as any
}

const DISPATCH_AND_APPROVAL = [
    ledger('task_dispatched', DISPATCH_AT),
    ledger('task_approval_needed', APPROVAL_AT),
]

describe('stale approval pinned with no live sniff available', () => {
    it('retires an approval explicitly even when the live status latch is still awaiting_approval', () => {
        const { activeWork, summary } = buildMeshActiveWork({
            meshId: 'mesh_test',
            queue: [] as any,
            ledgerEntries: [
                ...DISPATCH_AND_APPROVAL,
                ledger('task_approval_resolved', RESOLVED_AT, { resolution: 'approved' }),
            ],
            directDispatches: [] as any,
            // Core reproduction: both legacy contradiction paths are blocked by
            // this present-but-stale latch. The explicit retraction must still win.
            nodes: [{ id: NODE_ID, nodeId: NODE_ID, sessions: [{ id: SESSION_ID, status: 'awaiting_approval' }] }] as any,
            now: NOW,
        })

        expect(collectPendingApprovals(activeWork)).toEqual([])
        expect(activeWork.find(r => r.taskId === TASK_ID)).toBeUndefined()
        expect(summary.awaitingApprovalCount).toBe(0)
    })

    it('uses latest-transition-wins semantics when a later approval re-asserts the level', () => {
        const secondApprovalAt = '2026-09-12T10:32:00.000Z'
        const { activeWork } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_approval_resolved', RESOLVED_AT, { resolution: 'approved' }),
            ledger('task_approval_needed', secondApprovalAt),
        ])

        const approvals = collectPendingApprovals(activeWork)
        expect(approvals).toHaveLength(1)
        expect(approvals[0].waitingSince).toBe(secondApprovalAt)
    })

    it('passes supplied live nodes through the real notification collector', () => {
        const meshId = `mesh_live_nodes_banner_${Date.now()}`
        try {
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched', timestamp: DISPATCH_AT, nodeId: NODE_ID, sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { taskId: TASK_ID, source: 'direct', via: 'mesh_send_task', message: 'waiting' },
            } as any)
            appendLedgerEntry(meshId, {
                kind: 'task_approval_needed', timestamp: APPROVAL_AT, nodeId: NODE_ID, sessionId: SESSION_ID,
                providerType: 'claude-cli', payload: { taskId: TASK_ID, event: 'agent:waiting_approval' },
            } as any)

            const nodes = [{ id: NODE_ID, nodeId: NODE_ID, sessions: [{ id: SESSION_ID, status: 'idle' }] }] as any
            expect(buildMeshStatusLineForNotification(meshId, NOW, nodes)).toBeNull()
        } finally {
            __clearMeshLedgerForTests(meshId)
        }
    })

    it('retires the approval once a later task on the SAME session completes', () => {
        // The worker answered the modal, finished that turn, and took a follow-up
        // task which completed. The blocked task emits no terminal of its own — the
        // only evidence the modal closed is that its session moved on.
        const { activeWork } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_dispatched', '2026-09-12T10:32:00.000Z', { taskId: FOLLOW_UP_TASK_ID }),
            ledger('task_completed', TERMINAL_AT, { taskId: FOLLOW_UP_TASK_ID }),
        ])

        expect(collectPendingApprovals(activeWork)).toEqual([])
        // Retired as a terminal row, not merely relabelled: a record that stays in
        // activeWork under another active status still renders in the status line.
        expect(activeWork.find(r => r.taskId === TASK_ID)).toBeUndefined()
    })

    it('a later task_failed on the same session is equally conclusive', () => {
        const { activeWork } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_failed', TERMINAL_AT, { taskId: FOLLOW_UP_TASK_ID }),
        ])
        expect(collectPendingApprovals(activeWork)).toEqual([])
    })

    it('the retired record no longer contributes to the notification status line counts', () => {
        // The end-to-end symptom: `[Mesh] active 1: 1 awaiting_approval` pinned on
        // every coordinator notification long after the worker went idle.
        const { summary } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_completed', TERMINAL_AT, { taskId: FOLLOW_UP_TASK_ID }),
        ])
        expect(summary.awaitingApprovalCount).toBe(0)
        expect(summary.statusCounts.awaiting_approval).toBe(0)
    })

    it.each(['cancelled', 'completed', 'failed'] as const)(
        'does not resurrect a task whose queue row is terminal (%s) into banner activeWork',
        (status) => {
            const taskId = `terminal-queue-${status}`
            const built = buildWithoutLiveSniff([
                ledger('task_dispatched', DISPATCH_AT, { taskId }),
                // Legacy/orphan shape: approval has no taskId and matches by session.
                ledger('task_approval_needed', APPROVAL_AT, { taskId: undefined }),
            ], [queueRow(taskId, status)])

            expect(built.activeWork.some(record => record.taskId === taskId)).toBe(false)
            expect(renderBannerSnapshot(built)).toBeNull()
        },
    )

    it('keeps legitimate pending/assigned queue work visible exactly once', () => {
        for (const status of ['pending', 'assigned'] as const) {
            const taskId = `active-queue-${status}`
            const built = buildWithoutLiveSniff([
                ledger('task_dispatched', DISPATCH_AT, { taskId }),
            ], [queueRow(taskId, status)])

            expect(built.activeWork.filter(record => record.taskId === taskId)).toHaveLength(1)
            expect(renderBannerSnapshot(built)).toContain(`[Mesh] active 1: 1 ${status}`)
        }
    })

    it('removes a taskId-less approval from banner activeWork after its session stops', () => {
        const taskId = 'stopped-session-task'
        const built = buildWithoutLiveSniff([
            ledger('task_dispatched', DISPATCH_AT, { taskId }),
            ledger('task_approval_needed', APPROVAL_AT, { taskId: undefined }),
            ledger('session_stopped', TERMINAL_AT, { taskId: undefined }),
        ])

        expect(built.activeWork.some(record => record.taskId === taskId)).toBe(false)
        expect(renderBannerSnapshot(built)).toBeNull()
    })

    it('feeds session_stopped through the real banner ledger-kind collector', () => {
        const meshId = `mesh_stopped_banner_${Date.now()}`
        const taskId = 'stopped-session-collected-task'
        try {
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                timestamp: DISPATCH_AT,
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { taskId, source: 'direct', via: 'mesh_dispatch_task', message: 'direct dispatch awaiting approval' },
            } as any)
            appendLedgerEntry(meshId, {
                kind: 'task_approval_needed',
                timestamp: APPROVAL_AT,
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { event: 'agent:waiting_approval' },
            } as any)
            appendLedgerEntry(meshId, {
                kind: 'session_stopped',
                timestamp: TERMINAL_AT,
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { reason: 'worker stopped' },
            } as any)

            expect(buildMeshStatusLineForNotification(meshId, NOW)).toBeNull()
        } finally {
            __clearMeshLedgerForTests(meshId)
        }
    })

    it('reproduces the 2026-09-02 phantom through the real banner collector and renders no ghost', () => {
        const meshId = `mesh_phantom_banner_${Date.now()}`
        const taskId = 'adcec3f6-e241-4c41-a64f-e4a824090b3e'
        try {
            MeshRuntimeStore.getInstance().insertQueueEntry({
                ...queueRow(taskId, 'cancelled'),
                meshId,
                createdAt: '2026-09-02T10:00:00.000Z',
                updatedAt: '2026-09-02T10:05:00.000Z',
                dispatchTimestamp: '2026-09-02T10:00:00.000Z',
            })
            appendLedgerEntry(meshId, {
                kind: 'task_dispatched',
                timestamp: '2026-09-02T10:00:00.000Z',
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { taskId, source: 'direct', via: 'mesh_dispatch_task', message: 'direct dispatch awaiting approval' },
            } as any)
            appendLedgerEntry(meshId, {
                kind: 'task_approval_needed',
                timestamp: '2026-09-02T10:01:00.000Z',
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                // Historical orphan: payload.taskId absent, so ledger task_id is NULL.
                payload: { event: 'agent:waiting_approval' },
            } as any)
            appendLedgerEntry(meshId, {
                kind: 'session_stopped',
                timestamp: '2026-09-02T10:05:00.000Z',
                nodeId: NODE_ID,
                sessionId: SESSION_ID,
                providerType: 'claude-cli',
                payload: { reason: 'worker stopped' },
            } as any)
            // Deliberately no task_completed/task_failed row. This calls the same
            // getQueue/getActiveDirectDispatches/kind-filtered-ledger collector used at
            // injectPendingIntoCoordinator, then the real banner renderer.
            const thirteenDaysLater = new Date('2026-09-15T10:00:00.000Z').getTime()
            expect(buildMeshStatusLineForNotification(meshId, thirteenDaysLater)).toBeNull()
        } finally {
            __clearMeshQueueForTests(meshId)
            __clearMeshLedgerForTests(meshId)
        }
    })

    // ---- Reverse regression: a REAL approval must survive every one of these ----

    it('KEEPS a genuinely-blocked approval when the session has no later terminal', () => {
        const { activeWork } = buildWithoutLiveSniff(DISPATCH_AND_APPROVAL)
        const approvals = collectPendingApprovals(activeWork)

        expect(approvals).toHaveLength(1)
        expect(approvals[0]).toMatchObject({ nodeId: NODE_ID, sessionId: SESSION_ID, status: 'awaiting_approval' })
    })

    it('KEEPS it when the later terminal belongs to a DIFFERENT session', () => {
        // Session-scoped, not node-scoped: another session on the same node
        // finishing says nothing about this session's modal.
        const { activeWork } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_completed', TERMINAL_AT, { taskId: 'unrelated' }, 'sess_other'),
        ])
        expect(collectPendingApprovals(activeWork)).toHaveLength(1)
    })

    it('KEEPS it when the only same-session terminal PRECEDES the approval', () => {
        // A terminal from before the modal opened cannot have resolved it.
        const { activeWork } = buildWithoutLiveSniff([
            ledger('task_dispatched', DISPATCH_AT),
            ledger('task_completed', '2026-09-12T10:10:00.000Z', { taskId: 'earlier' }),
            ledger('task_approval_needed', APPROVAL_AT),
        ])
        expect(collectPendingApprovals(activeWork)).toHaveLength(1)
    })

    it('KEEPS it when the later completion is WEAK (false-idle) evidence', () => {
        // Same exclusion hasTerminalLedgerAuthorityForTask applies: a worker that
        // may still be mid-turn is not evidence the modal closed.
        const { activeWork } = buildWithoutLiveSniff([
            ...DISPATCH_AND_APPROVAL,
            ledger('task_completed', TERMINAL_AT, { taskId: FOLLOW_UP_TASK_ID, evidenceLevel: 'insufficient' }),
        ])
        expect(collectPendingApprovals(activeWork)).toHaveLength(1)
    })

    it('KEEPS it when a live sniff still reports the session blocked, despite a later session terminal', () => {
        // The live sniff stays PRIMARY. Direct observation that the modal is open
        // outranks the ledger inference that the session moved on.
        const { activeWork } = buildMeshActiveWork({
            meshId: 'mesh_test',
            queue: [] as any,
            ledgerEntries: [
                ...DISPATCH_AND_APPROVAL,
                ledger('task_completed', TERMINAL_AT, { taskId: FOLLOW_UP_TASK_ID }),
            ],
            directDispatches: [] as any,
            nodes: [{ id: NODE_ID, nodeId: NODE_ID, sessions: [{ id: SESSION_ID, status: 'awaiting_approval' }] }] as any,
            now: NOW,
        })
        expect(collectPendingApprovals(activeWork)).toHaveLength(1)
    })
})
