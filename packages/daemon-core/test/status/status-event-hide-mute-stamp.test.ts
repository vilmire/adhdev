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
 */
import { describe, expect, it, vi } from 'vitest'
import { DaemonStatusReporter } from '../../src/status/reporter.js'

function createReporter(instances: Record<string, { settings?: Record<string, unknown>; status?: string }>) {
    const sendMessage = vi.fn()
    const sendStatusEvent = vi.fn()

    const reporter = new DaemonStatusReporter({
        serverConn: { isConnected: () => true, sendMessage, getUserPlan: () => 'pro' },
        cdpManagers: new Map(),
        p2p: {
            isConnected: true,
            isAvailable: true,
            connectionState: 'connected',
            connectedPeerCount: 1,
            screenshotActive: false,
            sendStatus: vi.fn(),
            sendStatusEvent,
        },
        providerLoader: { resolve: () => null, getAll: () => [] },
        detectedIdes: [],
        instanceId: 'daemon-1',
        daemonVersion: '0.0.0-test',
        instanceManager: {
            collectAllStates: () => [],
            collectStatesByCategory: () => [],
            getInstance: (sessionId: string) => {
                const found = instances[sessionId]
                if (!found) return undefined
                return { getState: () => found as any }
            },
        },
        getScreenshotUsage: () => null,
    })

    return { reporter, sendMessage, sendStatusEvent }
}

/** The payload the daemon actually hands the cloud server. */
function serverPayload(sendMessage: ReturnType<typeof vi.fn>) {
    const call = sendMessage.mock.calls.find(([type]) => type === 'status_event')
    return call?.[1]
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
        const { reporter, sendMessage } = createReporter({
            'worker-1': { settings: COORDINATOR_SPAWNED_HIDDEN, status: 'waiting_choice' },
        })

        reporter.emitStatusEvent({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-1',
            providerType: 'claude-cli',
            modalMessage: 'Which approach?',
            modalButtons: ['A', 'B'],
        })

        const payload = serverPayload(sendMessage)
        expect(payload.surfaceHidden).toBe(true)
        expect(payload.muted).toBe(true)
    })

    it('stamps false for an owner-visible session so approval push still fires', () => {
        const { reporter, sendMessage } = createReporter({
            'owner-1': { settings: {}, status: 'waiting_approval' },
        })

        reporter.emitStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'owner-1',
            providerType: 'claude-cli',
            modalMessage: 'rm -rf build/',
            modalButtons: ['Approve', 'Deny'],
        })

        const payload = serverPayload(sendMessage)
        expect(payload.surfaceHidden).toBe(false)
        expect(payload.muted).toBe(false)
        // The deliberate push exception must survive: the modal text is what makes
        // the notification actionable. See CLAUDE.md content-boundary note.
        expect(payload.modalMessage).toBe('rm -rf build/')
        expect(payload.modalButtons).toEqual(['Approve', 'Deny'])
    })

    it('honors an explicit user un-mute over the coordinator-worker default', () => {
        const { reporter, sendMessage } = createReporter({
            'worker-2': {
                settings: { ...COORDINATOR_SPAWNED_HIDDEN, userHidden: false, userMuted: false },
                status: 'waiting_approval',
            },
        })

        reporter.emitStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'worker-2',
            providerType: 'claude-cli',
        })

        const payload = serverPayload(sendMessage)
        expect(payload.surfaceHidden).toBe(false)
        expect(payload.muted).toBe(false)
    })

    it('omits the flags for a session with no local instance (remote mesh worker)', () => {
        // The server then falls back to its snapshot join — unchanged legacy behavior.
        const { reporter, sendMessage } = createReporter({})

        reporter.emitStatusEvent({
            event: 'agent:waiting_approval',
            targetSessionId: 'remote-1',
            providerType: 'claude-cli',
        })

        const payload = serverPayload(sendMessage)
        expect(payload.surfaceHidden).toBeUndefined()
        expect(payload.muted).toBeUndefined()
    })

    it('still delivers the event to the coordinator over P2P when hidden', () => {
        // Muting hides the event from the OWNER; it must never kill the event,
        // or the coordinator never answers and the worker waits forever.
        const { reporter, sendStatusEvent, sendMessage } = createReporter({
            'worker-3': { settings: COORDINATOR_SPAWNED_HIDDEN, status: 'waiting_choice' },
        })

        reporter.emitStatusEvent({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-3',
            providerType: 'claude-cli',
        })

        expect(sendStatusEvent).toHaveBeenCalledTimes(1)
        expect(sendStatusEvent.mock.calls[0][0]).toMatchObject({
            event: 'agent:waiting_choice',
            targetSessionId: 'worker-3',
        })
        expect(serverPayload(sendMessage)).toBeTruthy()
    })
})
