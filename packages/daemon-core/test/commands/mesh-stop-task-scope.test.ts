import { describe, it, expect } from 'vitest'
import { evaluateMeshStopTaskScope } from '../../src/commands/mesh-stop-task-scope.js'

// CANCEL-STOP-TASK-SCOPE
//
// mesh_queue_cancel propagates agent_command(action:'stop') to the session named by the
// cancelled queue row's assignedSessionId. That stop is a HARD stop (CliManager.stopSession
// removes the instance). Before this fix the target was resolved from the queue row ALONE,
// with no check that the session was still running that task — so with a stale 'assigned'
// row a session that had moved on to another task was killed, destroying unrelated work
// (observed live 2026-09-02).
//
// The two halves that must BOTH hold:
//   DEFECT   — a session running some OTHER task must NOT be stopped.
//   CONTROL  — a session genuinely running the cancelled task must STILL be stopped.
// The control group is what separates this fix from simply disabling the cancel-stop.

describe('CANCEL-STOP-TASK-SCOPE — task identity resolution', () => {
    it('treats blank / non-string session ids as absent (fails open)', () => {
        expect(evaluateMeshStopTaskScope({ requestedTaskId: 'task1', meshActiveTaskId: '   ' }).reason).toBe('session_task_unknown')
        expect(evaluateMeshStopTaskScope({ requestedTaskId: 'task1', meshActiveTaskId: 42 }).reason).toBe('session_task_unknown')
    })
})

describe('CANCEL-STOP-TASK-SCOPE — the defect: unrelated work must survive', () => {
    it('REFUSES the stop when the session has moved on to a different task', () => {
        // The exact live scenario: session S finished task1 (its queue row lingering in
        // 'assigned'), then claimed task2 and is generating. Cancelling task1 must not kill it.
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            meshActiveTaskId: 'task2',
        })
        expect(decision.allowed).toBe(false)
        expect((decision as { sessionTaskId: string }).sessionTaskId).toBe('task2')
    })
})

describe('CANCEL-STOP-TASK-SCOPE — the control group: the original intent survives', () => {
    // These assertions are what prove the fix did not simply neuter the cancel-stop. The
    // comment at mesh-tools-queue.ts states the intent explicitly: "cancelling the queue row
    // alone does NOT stop a worker that already claimed the task and is generating". That
    // must still happen.
    it('ALLOWS the stop when the session is genuinely running the cancelled task', () => {
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            meshActiveTaskId: 'task1',
        })
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('task_match')
    })

    it('ALLOWS an unscoped stop (no taskId) — dashboard/operator stops are unchanged', () => {
        const decision = evaluateMeshStopTaskScope({
            meshActiveTaskId: 'task_whatever',
        })
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('not_task_scoped')
    })

    it('ALLOWS the stop when the session exposes NO task identity (fails open)', () => {
        // A worker mid-boot, or an adapter tracking neither id. Refusing here would silently
        // un-do the cancel-stop for exactly the workers most likely to be running the task —
        // a worse regression than the defect. Only a POSITIVE mismatch blocks.
        const decision = evaluateMeshStopTaskScope({ requestedTaskId: 'task1' })
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('session_task_unknown')
    })
})
