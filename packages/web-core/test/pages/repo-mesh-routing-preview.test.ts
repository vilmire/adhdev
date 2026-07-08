import { describe, expect, it } from 'vitest'

import { rankRoutingPreview, isSpreadStrategy } from '../../src/pages/repo-mesh/MeshRoutingPreview'

function node(id: string, priority = 0) {
    return { id, workspace: `/w/${id}`, policy: { schedulingPriority: priority } } as any
}
function assigned(nodeId: string) {
    return { id: `t-${nodeId}-${Math.random()}`, status: 'assigned', assignedNodeId: nodeId, message: 'x' } as any
}

describe('rankRoutingPreview (mirrors daemon orderEligibleNodes)', () => {
    it('isSpreadStrategy maps least_loaded/round_robin to spread, others not', () => {
        expect(isSpreadStrategy('least_loaded')).toBe(true)
        expect(isSpreadStrategy('round_robin')).toBe(true)
        expect(isSpreadStrategy('first_eligible')).toBe(false)
        expect(isSpreadStrategy('priority_only')).toBe(false)
        // unset resolves to In order → not spread
        expect(isSpreadStrategy(undefined as any)).toBe(false)
    })

    it('In order keeps config order regardless of priority/load', () => {
        const nodes = [node('a', 0), node('b', 99)]
        // b is higher priority and a is loaded, but In order ignores both.
        const queue = [assigned('a'), assigned('a')]
        const ranked = rankRoutingPreview(nodes, queue, 'first_eligible')
        expect(ranked.map(r => r.node.id)).toEqual(['a', 'b'])
        expect(ranked[0].rank).toBe(0)
    })

    it('Spread prefers higher priority first', () => {
        const nodes = [node('a', 1), node('b', 5)]
        const ranked = rankRoutingPreview(nodes, [], 'least_loaded')
        expect(ranked.map(r => r.node.id)).toEqual(['b', 'a'])
    })

    it('Spread breaks equal priority by least load', () => {
        const nodes = [node('a', 0), node('b', 0)]
        // a has 2 active, b has 0 → b wins
        const queue = [assigned('a'), assigned('a')]
        const ranked = rankRoutingPreview(nodes, queue, 'least_loaded')
        expect(ranked.map(r => r.node.id)).toEqual(['b', 'a'])
        expect(ranked[0].load).toBe(0)
        expect(ranked[1].load).toBe(2)
    })

    it('Spread flags equal (priority, load) nodes as tied with the winner', () => {
        const nodes = [node('a', 0), node('b', 0), node('c', 0)]
        const ranked = rankRoutingPreview(nodes, [], 'least_loaded')
        // all equal → first is winner, the other two tie with it
        expect(ranked[0].tiedWithWinner).toBe(false)
        expect(ranked.filter(r => r.tiedWithWinner).map(r => r.node.id).sort()).toEqual(['b', 'c'])
    })

    it('priority beats load under Spread (load only breaks ties)', () => {
        const nodes = [node('a', 5), node('b', 0)]
        // a is high priority but heavily loaded; still wins because priority is primary.
        const queue = [assigned('a'), assigned('a'), assigned('a')]
        const ranked = rankRoutingPreview(nodes, queue, 'least_loaded')
        expect(ranked[0].node.id).toBe('a')
    })
})
