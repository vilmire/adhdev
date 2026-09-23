import { describe, expect, it } from 'vitest'
import {
    attachMeshAssignment,
    currentMeshAttemptRef,
    detachMeshAssignment,
    releaseMeshAttemptRef,
    type MeshAssignmentHost,
} from '../../src/providers/cli-provider-mesh-assignment.js'

// Wiring-unification C4/C5: the worker's turn evidence carries the FULL
// attempt ref — the dispatch's `meshContext.attemptGeneration` rides the
// assignment onto the session — and the ledger's `release_attempt_ref`
// effect clears exactly the attempt it names.

function host(): MeshAssignmentHost & { updates: number } {
    const h = {
        instanceId: 'sess-1',
        settings: {} as Record<string, any>,
        meshTaskInjectedAt: 0,
        meshTaskAttachmentHistory: [],
        updates: 0,
        adapter: { updateRuntimeSettings: () => { h.updates++ } },
    }
    return h
}

describe('mesh attempt ref on the worker session', () => {
    it('carries the attempt generation from the assignment (R28: a post-reclaim generation must not read as 0)', () => {
        const h = host()
        attachMeshAssignment(h, { meshId: 'm1', taskId: 't1', attemptId: 'att-1', attemptGeneration: 2 })
        expect(currentMeshAttemptRef(h.settings)).toEqual({ attemptId: 'att-1', generation: 2 })
    })

    it('a new attempt without a generation never inherits the previous attempt\'s', () => {
        const h = host()
        attachMeshAssignment(h, { meshId: 'm1', taskId: 't1', attemptId: 'att-1', attemptGeneration: 3 })
        attachMeshAssignment(h, { meshId: 'm1', taskId: 't2', attemptId: 'att-2' })
        expect(currentMeshAttemptRef(h.settings)).toEqual({ attemptId: 'att-2', generation: 0 })
    })

    it('release clears exactly the named attempt and leaves the task binding; a different id is a no-op', () => {
        const h = host()
        attachMeshAssignment(h, { meshId: 'm1', nodeId: 'n1', taskId: 't1', attemptId: 'att-1', attemptGeneration: 1 })
        expect(releaseMeshAttemptRef(h, 'att-other')).toBe(false)
        expect(currentMeshAttemptRef(h.settings)).toEqual({ attemptId: 'att-1', generation: 1 })
        expect(releaseMeshAttemptRef(h, 'att-1')).toBe(true)
        expect(currentMeshAttemptRef(h.settings)).toBeNull()
        expect(h.settings.meshActiveAttemptGeneration).toBeUndefined()
        expect(h.settings).toMatchObject({ meshNodeFor: 'm1', meshNodeId: 'n1', meshActiveTaskId: 't1' })
    })

    it('detach clears the generation with the attempt', () => {
        const h = host()
        attachMeshAssignment(h, { meshId: 'm1', taskId: 't1', attemptId: 'att-1', attemptGeneration: 4 })
        detachMeshAssignment(h)
        expect(h.settings.meshActiveAttemptGeneration).toBeUndefined()
        expect(currentMeshAttemptRef(h.settings)).toBeNull()
    })
})
