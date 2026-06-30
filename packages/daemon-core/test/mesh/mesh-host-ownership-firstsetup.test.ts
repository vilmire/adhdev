import { describe, expect, it } from 'vitest'
import { resolveMeshHostStatus } from '../../src/mesh/mesh-host-ownership.js'

/**
 * HOST-MISSEED-FIRSTSETUP regression — a host mesh whose `meshHost` was persisted
 * as `{role:'host', pairing:{status:'not_configured'}}` with NO `hostDaemonId`
 * (the first-setup miss) must be pinned to the evaluating daemon on read, so the
 * dashboard renders the local daemon as host instead of 'no host yet'.
 *
 * HARD guard: the synthesis fires ONLY for role:'host'. A role:'member' daemon must
 * never fill itself in as host (it would falsely claim coordinator/queue ownership).
 */
describe('HOST-MISSEED-FIRSTSETUP read-side host pin', () => {
    const localDaemonId = 'daemon_mach_1b46842a15d3409d96ad33e767a916dd'

    it('synthesizes hostDaemonId from the local daemon for a host mesh missing the pin', () => {
        const mesh = { meshHost: { role: 'host', pairing: { status: 'not_configured' } } }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.role).toBe('host')
        expect(status.hostDaemonId).toBe(localDaemonId)
    })

    it('anchors hostNodeId to the node representing the local daemon (id-form agnostic)', () => {
        const mesh = {
            meshHost: { role: 'host', pairing: { status: 'not_configured' } },
            nodes: [
                // bare form vs cloud-prefixed local form — daemonIdsEquivalent must match
                { id: 'node-self', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' },
                { id: 'node-other', daemonId: 'daemon_mach_b6c8' },
            ],
        }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(localDaemonId)
        expect(status.hostNodeId).toBe('node-self')
    })

    it('does NOT synthesize a host pin for a member daemon', () => {
        const mesh = { meshHost: { role: 'member', pairing: { status: 'not_configured' } } }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.role).toBe('member')
        expect(status.hostDaemonId).toBeUndefined()
        expect(status.canOwnCoordinator).toBe(false)
    })

    it('keeps an already-persisted hostDaemonId untouched (no override)', () => {
        const persisted = 'daemon_mach_persistedhost'
        const mesh = { meshHost: { role: 'host', hostDaemonId: persisted } }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(persisted)
    })

    it('does not synthesize when no localDaemonId is supplied (role-only callers)', () => {
        const mesh = { meshHost: { role: 'host', pairing: { status: 'not_configured' } } }
        const status = resolveMeshHostStatus(mesh)
        expect(status.role).toBe('host')
        expect(status.hostDaemonId).toBeUndefined()
    })
})
