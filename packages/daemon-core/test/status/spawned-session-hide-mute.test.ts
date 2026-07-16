import { describe, expect, it } from 'vitest'
import {
    resolveSpawnedSessionHideMute,
    resolveSurfaceHidden,
    resolveMuted,
    isCoordinatorSpawnedHiddenWorker,
} from '../../src/status/builders.js'

// The cloud daemon's synthetic remote-mesh-session mirror reuses this exact resolver
// (exported for daemon-cloud) so a coordinator-spawned worker hides+mutes on the
// cloud dashboard identically to a local worker on standalone. Pin the shared logic.
describe('resolveSpawnedSessionHideMute', () => {
    it('hides + mutes a coordinator-spawned worker with hidden visibility', () => {
        const r = resolveSpawnedSessionHideMute({
            launchedByCoordinator: true,
            meshNodeFor: 'mesh_a',
            spawnedSessionVisibility: 'hidden',
        })
        expect(r).toEqual({ surfaceHidden: true, muted: true })
    })

    it('does not hide or mute a coordinator-spawned worker with visible visibility', () => {
        const r = resolveSpawnedSessionHideMute({
            launchedByCoordinator: true,
            meshNodeFor: 'mesh_a',
            spawnedSessionVisibility: 'visible',
        })
        expect(r).toEqual({ surfaceHidden: false, muted: false })
    })

    it('does not mute a non-coordinator session even when spawnedSessionVisibility=hidden', () => {
        // surfaceHidden still respects an explicit spawnedSessionVisibility=hidden, but
        // mute is gated on the coordinator-spawned predicate.
        const r = resolveSpawnedSessionHideMute({ spawnedSessionVisibility: 'hidden' })
        expect(r.surfaceHidden).toBe(true)
        expect(r.muted).toBe(false)
    })

    it('honors an explicit user un-hide / un-mute over the worker default', () => {
        const r = resolveSpawnedSessionHideMute({
            launchedByCoordinator: true,
            meshNodeFor: 'mesh_a',
            spawnedSessionVisibility: 'hidden',
            userHidden: false,
            userMuted: false,
        })
        expect(r).toEqual({ surfaceHidden: false, muted: false })
    })

    it('honors an explicit user hide / mute even without the worker default', () => {
        const r = resolveSpawnedSessionHideMute({ userHidden: true, userMuted: true })
        expect(r).toEqual({ surfaceHidden: true, muted: true })
    })

    it('resolver wrappers agree with the combined helper', () => {
        const settings = { launchedByCoordinator: true, meshNodeFor: 'mesh_a', spawnedSessionVisibility: 'hidden' }
        expect(isCoordinatorSpawnedHiddenWorker(settings)).toBe(true)
        expect(resolveSurfaceHidden(settings)).toBe(true)
        expect(resolveMuted(settings)).toBe(true)
    })
})
