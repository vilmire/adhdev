import { describe, it, expect } from 'vitest'
import { evaluateMeshStopTaskScope, resolveSessionCurrentTaskId } from '../../src/commands/mesh-stop-task-scope.js'

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
    it('prefers the per-turn binding over the last-write-wins session scalar', () => {
        // Mirrors CliProviderInstance.completingTurnTaskId(): the per-turn binding is
        // authoritative because the scalar is overwritten when a second task attaches.
        expect(resolveSessionCurrentTaskId({
            currentTurnTaskId: 'task_current_turn',
            meshActiveTaskId: 'task_stale_scalar',
        })).toBe('task_current_turn')
    })

    it('falls back to the session scalar when there is no per-turn binding', () => {
        expect(resolveSessionCurrentTaskId({ meshActiveTaskId: 'task_scalar' })).toBe('task_scalar')
    })

    it('treats blank / non-string ids as absent', () => {
        expect(resolveSessionCurrentTaskId({ currentTurnTaskId: '   ', meshActiveTaskId: '' })).toBeUndefined()
        expect(resolveSessionCurrentTaskId({ currentTurnTaskId: 42, meshActiveTaskId: null })).toBeUndefined()
        // A blank per-turn binding must not shadow a real scalar.
        expect(resolveSessionCurrentTaskId({ currentTurnTaskId: '  ', meshActiveTaskId: 'task_real' })).toBe('task_real')
    })
})

describe('CANCEL-STOP-TASK-SCOPE — the defect: unrelated work must survive', () => {
    it('REFUSES the stop when the session has moved on to a different task (per-turn binding)', () => {
        // The exact live scenario: session S finished task1 (its queue row lingering in
        // 'assigned'), then claimed task2 and is generating. Cancelling task1 must not kill it.
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            currentTurnTaskId: 'task2',
        })
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toBe('task_mismatch')
        expect((decision as { sessionTaskId: string }).sessionTaskId).toBe('task2')
    })

    it('REFUSES the stop when only the session scalar has moved on', () => {
        // An adapter that tracks no per-turn id still reports its current assignment via the
        // scalar — a mismatch there is just as decisive.
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            meshActiveTaskId: 'task2',
        })
        expect(decision.allowed).toBe(false)
        expect((decision as { sessionTaskId: string }).sessionTaskId).toBe('task2')
    })

    it('REFUSES even when the STALE scalar still names the cancelled task', () => {
        // Subtle and important: the scalar is last-write-wins, so it can lag. The per-turn
        // binding says task2 is what is actually running. Trusting the stale scalar here
        // would reproduce the exact defect, so the binding must win.
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            currentTurnTaskId: 'task2',
            meshActiveTaskId: 'task1',
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
            currentTurnTaskId: 'task1',
        })
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('task_match')
    })

    it('ALLOWS the stop when only the session scalar identifies the cancelled task', () => {
        const decision = evaluateMeshStopTaskScope({
            requestedTaskId: 'task1',
            meshActiveTaskId: 'task1',
        })
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('task_match')
    })

    it('ALLOWS an unscoped stop (no taskId) — dashboard/operator stops are unchanged', () => {
        const decision = evaluateMeshStopTaskScope({
            currentTurnTaskId: 'task_whatever',
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
