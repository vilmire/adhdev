/**
 * Blueprint route-preview derivations: the pinned-vs-generic forecast
 * requests, their matrix keys and the one-line labels.
 */
import { describe, expect, it } from 'vitest'
import {
    ROUTE_PREVIEW_COMPACT_DIFFICULTY,
    resolveCompactRoutePreviewLabel,
    buildPinnedSlotLabels,
    buildRoutePreviewRequests,
    routePreviewKey,
    routePreviewNextSlotLabel,
} from '../../src/components/MeshGraph/blueprintViewModel'

/**
 * Route preview respects the pin (owner observation 2026-08-25): a task
 * pinned to a node was annotated with the UNPINNED forecast, so the
 * blueprint predicted a machine the pinned task could never land on. The
 * engine has the pin axis (mesh_route_preview targetNodeId); these pin the
 * display-axis fix — pinned tasks request and show their own preview, the
 * generic forecast stays but is a separate reading.
 */
const previewNode = (nodeId: string, providerType: string, model?: string) => ({
    nodeId,
    predictedWinner: { providerType, model },
    stages: { fitness: [{ providerType, model }] },
})

describe('buildRoutePreviewRequests', () => {
    const GENERIC = [{ difficulty: 'easy' }, { difficulty: 'medium' }, { difficulty: 'difficult' }, { difficulty: 'freeform' }]

    it('requests only the four generic difficulties when nothing is pinned', () => {
        expect(buildRoutePreviewRequests([])).toEqual(GENERIC)
        expect(buildRoutePreviewRequests([{ status: 'pending', difficulty: 'difficult' }])).toEqual(GENERIC)
    })

    it('adds a pinned preview per pending pinned task, alongside the generic sweep', () => {
        const requests = buildRoutePreviewRequests([
            { status: 'pending', difficulty: 'difficult', targetNodeId: 'node-wt' },
        ])
        expect(requests).toEqual([...GENERIC, { difficulty: 'difficult', targetNodeId: 'node-wt' }])
    })

    it('dedupes tasks sharing one (difficulty, targetNodeId) and defaults a missing difficulty to medium', () => {
        const requests = buildRoutePreviewRequests([
            { status: 'pending', difficulty: 'difficult', targetNodeId: 'node-wt' },
            { status: 'pending', difficulty: 'difficult', targetNodeId: 'node-wt' },
            { status: 'pending', targetNodeId: 'node-base' },
        ])
        expect(requests).toEqual([
            ...GENERIC,
            { difficulty: 'difficult', targetNodeId: 'node-wt' },
            { difficulty: 'medium', targetNodeId: 'node-base' },
        ])
    })

    it('ignores pins on non-pending tasks — they already landed or settled', () => {
        const requests = buildRoutePreviewRequests([
            { status: 'assigned', difficulty: 'difficult', targetNodeId: 'node-wt' },
            { status: 'completed', difficulty: 'difficult', targetNodeId: 'node-wt' },
        ])
        expect(requests).toEqual(GENERIC)
    })
})

describe('routePreviewKey', () => {
    it('keeps the generic forecast under the bare difficulty and pinned previews under difficulty::nodeId', () => {
        expect(routePreviewKey('difficult')).toBe('difficult')
        expect(routePreviewKey('difficult', 'node-wt')).toBe('difficult::node-wt')
    })
})

describe('routePreviewNextSlotLabel / buildPinnedSlotLabels', () => {
    // The owner's case: unpinned 'difficult' predicts Jupiter, the pinned
    // preview for the same difficulty predicts the worktree node instead.
    const matrix = {
        difficult: [previewNode('node-jupiter', 'claude-cli', 'claude-sonnet')],
        'difficult::node-wt': [previewNode('node-wt', 'kimi', 'k3')],
    }

    it('labels the first node top fitness slot, with the node suffix', () => {
        const suffix = (nodeId: string) => (nodeId === 'node-wt' ? ' @ ⎇ wt-branch' : '')
        expect(routePreviewNextSlotLabel(matrix['difficult::node-wt'], suffix)).toBe('kimi·k3 @ ⎇ wt-branch')
        expect(routePreviewNextSlotLabel(matrix.difficult, suffix)).toBe('claude-cli·claude-sonnet')
    })

    it('falls back to predictedWinner when the fitness stage is empty', () => {
        expect(routePreviewNextSlotLabel([{ nodeId: 'n1', predictedWinner: { providerType: 'kimi' } }])).toBe('kimi')
        expect(routePreviewNextSlotLabel([])).toBeUndefined()
        expect(routePreviewNextSlotLabel(undefined)).toBeUndefined()
    })

    it('maps pending pinned tasks to their PINNED preview — never the generic one', () => {
        const labels = buildPinnedSlotLabels(
            [
                { id: 't-pinned', status: 'pending', difficulty: 'difficult', targetNodeId: 'node-wt' },
                { id: 't-unpinned', status: 'pending', difficulty: 'difficult' },
                { id: 't-settled', status: 'completed', difficulty: 'difficult', targetNodeId: 'node-wt' },
            ],
            matrix,
        )
        expect(labels).toEqual({ 't-pinned': 'kimi·k3' })
    })
})

describe('resolveCompactRoutePreviewLabel — the narrow-viewport one-liner', () => {
    it('reads the MEDIUM row, which is the difficulty an unclassified task gets', () => {
        expect(resolveCompactRoutePreviewLabel({
            easy: 'kimi·k3',
            medium: 'claude-cli·sonnet',
            difficult: 'claude-cli·opus',
        })).toBe('claude-cli·sonnet')
        expect(ROUTE_PREVIEW_COMPACT_DIFFICULTY).toBe('medium')
    })

    it('reports absence rather than borrowing another difficulty — a phone showing the easy slot as if it were the answer is the misprediction the pinned-preview work already fixed once', () => {
        expect(resolveCompactRoutePreviewLabel({ easy: 'kimi·k3', difficult: 'claude-cli·opus' })).toBeUndefined()
        expect(resolveCompactRoutePreviewLabel({})).toBeUndefined()
        expect(resolveCompactRoutePreviewLabel(undefined)).toBeUndefined()
    })
})
