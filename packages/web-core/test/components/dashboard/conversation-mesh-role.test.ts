// @vitest-environment jsdom
//
// Owner feedback (2026-09-27): coordinator conversations must be recognisable
// at a glance on every dashboard surface. `getConversationMeshRole` is the one
// rule every surface reads; the mesh name comes from a registry that the mesh
// list / mesh status reads fill, so labelling a conversation never costs a
// network call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    getConversationMeshRole,
    getMeshRoleMeshLabel,
    isCoordinatorConversation,
    isMeshGraphAvailableFor,
} from '../../../src/components/dashboard/conversation-mesh-role'
import { isMeshGraphConversation } from '../../../src/components/dashboard/conversation-presenters'
import {
    getMeshName,
    getMeshNamesVersion,
    rememberMeshNames,
    resetMeshNameRegistry,
    subscribeMeshNames,
} from '../../../src/utils/mesh-name-registry'
import { primeCoordinatorMeshStatus, resetCoordinatorMeshStatusStore } from '../../../src/utils/coordinator-mesh-status-store'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

type Conv = Pick<ActiveConversation, 'coordinator' | 'settings'> & { daemonId?: string }

describe('getConversationMeshRole', () => {
    beforeEach(() => resetMeshNameRegistry())
    afterEach(() => { resetMeshNameRegistry(); resetCoordinatorMeshStatusStore() })

    it('is a coordinator when the daemon stamped coordinator.meshId', () => {
        const conv: Conv = { coordinator: { meshId: 'mesh-a', role: 'coordinator' } }
        expect(getConversationMeshRole(conv)).toEqual({ role: 'coordinator', meshId: 'mesh-a', meshName: null })
        expect(isCoordinatorConversation(conv)).toBe(true)
    })

    it('is a coordinator from the launch envelope (settings.meshCoordinatorFor) alone', () => {
        expect(getConversationMeshRole({ settings: { meshCoordinatorFor: ' mesh-b ' } })).toMatchObject({ role: 'coordinator', meshId: 'mesh-b' })
    })

    it('the coordinator marker wins over a worker marker on the same session', () => {
        const conv: Conv = { settings: { meshNodeFor: 'mesh-a', meshCoordinatorFor: 'mesh-a' } }
        expect(getConversationMeshRole(conv).role).toBe('coordinator')
    })

    it('is a worker for settings.meshNodeFor, or launchedByCoordinator without a mesh id', () => {
        expect(getConversationMeshRole({ settings: { meshNodeFor: 'mesh-a' } })).toEqual({ role: 'worker', meshId: 'mesh-a', meshName: null })
        expect(getConversationMeshRole({ settings: { launchedByCoordinator: true } })).toEqual({ role: 'worker', meshId: null, meshName: null })
    })

    it('has no role for plain chats, blank ids, or a missing conversation', () => {
        expect(getConversationMeshRole({}).role).toBeNull()
        expect(getConversationMeshRole({ settings: { meshCoordinatorFor: '   ', meshNodeFor: '' } }).role).toBeNull()
        expect(getConversationMeshRole({ settings: { launchedByCoordinator: 'yes' } }).role).toBeNull()
        expect(getConversationMeshRole(undefined).role).toBeNull()
    })

    it('resolves the mesh name from the registry, falling back to the id for the label', () => {
        const conv: Conv = { settings: { meshCoordinatorFor: 'mesh-a' } }
        expect(getMeshRoleMeshLabel(getConversationMeshRole(conv))).toBe('mesh-a')
        rememberMeshNames([{ id: 'mesh-a', name: 'adhdev' }])
        expect(getConversationMeshRole(conv).meshName).toBe('adhdev')
        expect(getMeshRoleMeshLabel(getConversationMeshRole(conv))).toBe('adhdev')
    })

    it('mesh graph is available only for a coordinator bound to a daemon (all predicates agree)', () => {
        const coordinator: Conv = { daemonId: 'd-1', coordinator: { meshId: 'mesh-a', role: 'coordinator' } }
        const unbound: Conv = { coordinator: { meshId: 'mesh-a', role: 'coordinator' } }
        const worker: Conv = { daemonId: 'd-1', settings: { meshNodeFor: 'mesh-a' } }
        expect(isMeshGraphAvailableFor(coordinator)).toBe(true)
        expect(isMeshGraphAvailableFor(unbound)).toBe(false)
        expect(isMeshGraphAvailableFor(worker)).toBe(false)
        expect(isMeshGraphConversation(coordinator as ActiveConversation)).toBe(true)
        expect(isMeshGraphConversation(worker as ActiveConversation)).toBe(false)
    })
})

describe('mesh name registry', () => {
    beforeEach(() => resetMeshNameRegistry())
    afterEach(() => { resetMeshNameRegistry(); resetCoordinatorMeshStatusStore() })

    it('ignores id-only fallback names and notifies subscribers only on change', () => {
        let calls = 0
        const off = subscribeMeshNames(() => { calls += 1 })
        const before = getMeshNamesVersion()
        rememberMeshNames([{ id: 'mesh-a', name: 'mesh-a' }, { id: '', name: 'x' }, null])
        expect(getMeshName('mesh-a')).toBeNull()
        expect(calls).toBe(0)
        rememberMeshNames([{ id: 'mesh-a', name: 'adhdev' }])
        rememberMeshNames([{ id: 'mesh-a', name: 'adhdev' }])
        expect(calls).toBe(1)
        expect(getMeshNamesVersion()).toBe(before + 1)
        off()
    })

    it('persists names for the next page load (per-viewer convenience)', () => {
        const setItem = vi.spyOn(globalThis.localStorage, 'setItem')
        rememberMeshNames([{ id: 'mesh-a', name: 'adhdev' }])
        expect(setItem).toHaveBeenCalledWith('adhdev:mesh-names:v1', JSON.stringify({ 'mesh-a': 'adhdev' }))
        setItem.mockRestore()
    })

    it('keeps working when storage throws', () => {
        const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        expect(() => rememberMeshNames([{ id: 'mesh-q', name: 'quota' }])).not.toThrow()
        expect(getMeshName('mesh-q')).toBe('quota')
        setItem.mockRestore()
    })

    it('learns the name from a coordinator mesh-status answer (no extra request)', () => {
        primeCoordinatorMeshStatus('mesh-z', { meshName: 'zeta' } as never, 'd-1')
        expect(getMeshName('mesh-z')).toBe('zeta')
    })
})
