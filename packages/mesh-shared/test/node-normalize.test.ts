import { describe, expect, it } from 'vitest'
import { normalizeMeshNodeId, meshNodeIdMatches } from '../src/node-normalize'

describe('normalizeMeshNodeId', () => {
    it('reads the config canonical `id` form', () => {
        expect(normalizeMeshNodeId({ id: 'node_abc' })).toBe('node_abc')
    })

    it('reads the runtime/wire `nodeId` form', () => {
        expect(normalizeMeshNodeId({ nodeId: 'node_abc' })).toBe('node_abc')
    })

    it('reads the SQLite `node_id` form', () => {
        expect(normalizeMeshNodeId({ node_id: 'node_abc' })).toBe('node_abc')
    })

    it('prefers id, then nodeId, then node_id (all carry the same value)', () => {
        expect(normalizeMeshNodeId({ id: 'a', nodeId: 'b', node_id: 'c' })).toBe('a')
        expect(normalizeMeshNodeId({ nodeId: 'b', node_id: 'c' })).toBe('b')
        expect(normalizeMeshNodeId({ node_id: 'c' })).toBe('c')
    })

    it('trims whitespace and skips empty forms', () => {
        expect(normalizeMeshNodeId({ id: '   ', nodeId: '  node_x  ' })).toBe('node_x')
    })

    it('returns undefined when no id form is present', () => {
        expect(normalizeMeshNodeId({})).toBeUndefined()
        expect(normalizeMeshNodeId(null)).toBeUndefined()
        expect(normalizeMeshNodeId(undefined)).toBeUndefined()
    })
})

describe('meshNodeIdMatches', () => {
    const candidate = 'node_target'

    it('matches the same node id across all three serialization forms', () => {
        expect(meshNodeIdMatches({ id: candidate }, candidate)).toBe(true)
        expect(meshNodeIdMatches({ nodeId: candidate }, candidate)).toBe(true)
        // node_id form — the one the 2-way readInlineMeshNodeId used to drop.
        expect(meshNodeIdMatches({ node_id: candidate }, candidate)).toBe(true)
    })

    it('does not match a different id', () => {
        expect(meshNodeIdMatches({ id: 'node_other' }, candidate)).toBe(false)
        expect(meshNodeIdMatches({ node_id: 'node_other' }, candidate)).toBe(false)
    })

    it('never matches when either side is empty', () => {
        expect(meshNodeIdMatches({}, candidate)).toBe(false)
        expect(meshNodeIdMatches({ id: candidate }, '')).toBe(false)
        expect(meshNodeIdMatches({ id: candidate }, undefined)).toBe(false)
        expect(meshNodeIdMatches(null, candidate)).toBe(false)
    })
})
