import { describe, expect, it, vi } from 'vitest'
import { detachLocalMeshTaskStamp } from '../../src/boot/stages/mesh-runtime.js'

// WORKER-BIND-IDLE-DETACH (2026-09-24): the owner-decides half of the fix.
// A worker session's OWN idle edge (generating_completed) is withheld from
// detaching while it holds a live worker-MCP bind (see
// cli-provider-events.test coverage for that half) — so the local stamp must
// instead clear at the ONE place the owner actually decided the session is
// done with this task: the ledger's `cancel_dispatch(revokeBind: true)`
// effect (reclaim / redrive cutting a generation), which `wireTurnLedger`
// wires to call BOTH `revokeCutSessionWorkerBind` (bind/token revoke) AND
// this function (local stamp detach) via `ports.revokeWorkerBind`.
//
// `detachLocalMeshTaskStamp` is that second half, isolated so it can be unit
// tested without driving a full ledger reclaim scenario (dispatch → deliver →
// hold-expiry → reclaim) end-to-end — the same testing posture the sibling
// `releaseLocalAttemptRef` executor already has (no direct unit test either;
// both are thin `components.instanceManager` walks).

function fakeInstance(settings: Record<string, unknown>) {
    const detach = vi.fn(() => { settings = {} })
    return {
        getState: () => ({ settings }),
        detachMeshAssignment: detach,
        get detach() { return detach },
    }
}

function componentsWith(instances: Record<string, ReturnType<typeof fakeInstance> | undefined>) {
    return {
        instanceManager: {
            getInstance: (id: string) => instances[id],
        },
    } as any
}

describe('detachLocalMeshTaskStamp', () => {
    it('detaches the local instance when its CURRENT stamp matches the cut task', () => {
        const inst = fakeInstance({ meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-A' })
        const components = componentsWith({ 'sess-1': inst })

        detachLocalMeshTaskStamp(components, { sessionId: 'sess-1', taskId: 'task-A' })

        expect(inst.detach).toHaveBeenCalledTimes(1)
    })

    it('does NOT detach when the session has since moved on to a DIFFERENT task', () => {
        // A stale/late cancel for task-A arrives after the session was already
        // re-stamped (idle re-stamp, wave rc.40) to task-B. Detaching here would
        // tear down task-B's live stamp for a cancel that no longer applies to it.
        const inst = fakeInstance({ meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-B' })
        const components = componentsWith({ 'sess-1': inst })

        detachLocalMeshTaskStamp(components, { sessionId: 'sess-1', taskId: 'task-A' })

        expect(inst.detach).not.toHaveBeenCalled()
    })

    it('is a silent no-op when no local instance holds the cut session (remote session, or already exited)', () => {
        const components = componentsWith({})
        expect(() => detachLocalMeshTaskStamp(components, { sessionId: 'sess-remote', taskId: 'task-A' })).not.toThrow()
    })

    it('is a silent no-op when the request carries no taskId (nothing to detach)', () => {
        const inst = fakeInstance({ meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-A' })
        const components = componentsWith({ 'sess-1': inst })

        detachLocalMeshTaskStamp(components, { sessionId: 'sess-1', taskId: null })

        expect(inst.detach).not.toHaveBeenCalled()
    })

    it('is a silent no-op when the local instance has no detachMeshAssignment (defensive)', () => {
        const components = componentsWith({ 'sess-1': { getState: () => ({ settings: { meshActiveTaskId: 'task-A' } }) } as any })
        expect(() => detachLocalMeshTaskStamp(components, { sessionId: 'sess-1', taskId: 'task-A' })).not.toThrow()
    })

    it('falls through to detaching anyway when getState throws (best-effort, matches the sibling executors\' posture)', () => {
        const detach = vi.fn()
        const components = componentsWith({
            'sess-1': { getState: () => { throw new Error('boom') }, detachMeshAssignment: detach } as any,
        })

        expect(() => detachLocalMeshTaskStamp(components, { sessionId: 'sess-1', taskId: 'task-A' })).not.toThrow()
        expect(detach).toHaveBeenCalledTimes(1)
    })
})
