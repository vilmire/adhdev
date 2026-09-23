/**
 * Regression: a coordinator-spawned HIDDEN worker's approval/choice event must
 * carry its own visibility so the server can suppress the owner's Web Push.
 *
 * Live incident (2026-08-20): the owner's phone buzzed with a choice dialog from
 * a mesh worker that was correctly flagged surfaceHidden+muted. The server gate
 * existed but joined the event against the last `status_report` snapshot — and
 * that snapshot travels on a different, slower channel (throttled 5s, dedup up to
 * ~5min, periodic 30s) than the event, which fires synchronously on the PTY tick.
 * A worker that reached a modal before its first snapshot landed was simply absent
 * from the server's map, and the gate fails OPEN. Stamping the flags onto the
 * event itself removes the ordering dependency entirely.
 *
 * Moved onto status/status-event.ts's projectServerStatusEvent +
 * createInstanceHideMuteResolver (wiring-unification B5): the hide/mute stamp
 * used to be a private method on DaemonStatusReporter (buildServerStatusEvent /
 * resolveEventHideMute), which is now the shared projection both hosts use.
 */
import { describe, expect, it } from 'vitest'
import { createInstanceHideMuteResolver, projectServerStatusEvent } from '../../src/status/status-event.js'
import type { ProviderState } from '../../src/providers/provider-instance.js'

function createResolver(instances: Record<string, { settings?: Record<string, unknown>; status?: string }>) {
    const instanceManager = {
        getInstance: (sessionId: string) => {
            const found = instances[sessionId]
            if (!found) return undefined
            return { getState: () => found as unknown as ProviderState }
        },
    }
    return createInstanceHideMuteResolver(instanceManager)
}

/**
 * A real coordinator-spawned hidden worker. All three fields are required by
 * isCoordinatorSpawnedHiddenWorker (builders.ts) for the MUTE default — hiding
 * alone only needs spawnedSessionVisibility.
 */
const COORDINATOR_SPAWNED_HIDDEN = {
    launchedByCoordinator: true,
    meshNodeFor: 'node_84407c5a5e554421b06f1a42fc4ecca9',
    spawnedSessionVisibility: 'hidden',
}

describe('status_event visibility stamping', () => {
    it('stamps surfaceHidden+muted for a coordinator-spawned hidden worker', () => {
        const resolveHideMute = createResolver({
            'worker-1': { settings: COORDINATOR_SPAWNED_HIDDEN, status: 'waiting_choice' },
        })

        const payload = projectServerStatusEvent({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-1',
            providerType: 'claude-cli',
            modalMessage: 'Which approach?',
            modalButtons: ['A', 'B'],
        }, resolveHideMute)!

        expect(payload.surfaceHidden).toBe(true)
        expect(payload.muted).toBe(true)
    })

    it('stamps false for an owner-visible session so approval push still fires', () => {
        const resolveHideMute = createResolver({
            'owner-1': { settings: {}, status: 'waiting_approval' },
        })

        const payload = projectServerStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'owner-1',
            providerType: 'claude-cli',
            modalMessage: 'rm -rf build/',
            modalButtons: ['Approve', 'Deny'],
        }, resolveHideMute)!

        expect(payload.surfaceHidden).toBe(false)
        expect(payload.muted).toBe(false)
        // The deliberate push exception must survive: the modal text is what makes
        // the notification actionable. See CLAUDE.md content-boundary note.
        expect(payload.modalMessage).toBe('rm -rf build/')
        expect(payload.modalButtons).toEqual(['Approve', 'Deny'])
    })

    it('honors an explicit user un-mute over the coordinator-worker default', () => {
        const resolveHideMute = createResolver({
            'worker-2': {
                settings: { ...COORDINATOR_SPAWNED_HIDDEN, userHidden: false, userMuted: false },
                status: 'waiting_approval',
            },
        })

        const payload = projectServerStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'worker-2',
            providerType: 'claude-cli',
        }, resolveHideMute)!

        expect(payload.surfaceHidden).toBe(false)
        expect(payload.muted).toBe(false)
    })

    it('omits the flags for a session with no local instance (remote mesh worker)', () => {
        // The server then falls back to its snapshot join — unchanged legacy behavior.
        const resolveHideMute = createResolver({})

        const payload = projectServerStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'remote-1',
            providerType: 'claude-cli',
        }, resolveHideMute)!

        expect(payload.surfaceHidden).toBeUndefined()
        expect(payload.muted).toBeUndefined()
    })

    it('still builds the event for P2P delivery to the coordinator when hidden', () => {
        // Muting hides the event from the OWNER; it must never kill the event,
        // or the coordinator never answers and the worker waits forever. The
        // dashboard/P2P leg is a separate projection (projectP2PStatusEvent);
        // this only pins that the server-bound builder itself still returns a
        // payload rather than null for a hidden worker.
        const resolveHideMute = createResolver({
            'worker-3': { settings: COORDINATOR_SPAWNED_HIDDEN, status: 'waiting_choice' },
        })

        const payload = projectServerStatusEvent({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-3',
            providerType: 'claude-cli',
        }, resolveHideMute)

        expect(payload).toMatchObject({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-3',
        })
    })
})
