import { describe, expect, it } from 'vitest'
import { resolveMeshHostStatus, requireMeshHostQueueOwner } from '../../src/mesh/mesh-host-ownership.js'

/**
 * HOST-SELF-SYNTHESIS-GUARD regression.
 *
 * The HOST-MISSEED-FIRSTSETUP read-side default fills `hostDaemonId = localDaemonId`
 * for a `role:'host'` mesh with no persisted pin. `meshHost.role` defaults to 'host'
 * for EVERY peer, so on a multi-peer mesh with no persisted pin *every* daemon answers
 * "I am the host" — and the dashboard badge then shows whichever daemon happened to
 * answer mesh_status (P2P arrival order). That is not a display glitch: the same
 * arbitrary id is the Launch target, and a launch permanently pins the wrong machine.
 *
 * The guard: synthesis is confidence-scoped. It fires only when the mesh cannot
 * plausibly be hosted by a *different* daemon — i.e. the mesh has no node bound to a
 * daemon other than the evaluating one. When a foreign-daemon node exists and no pin
 * was persisted, the host is genuinely UNKNOWN and the resolver must say so rather
 * than answer with itself.
 */
describe('HOST-SELF-SYNTHESIS-GUARD multi-peer self-synthesis', () => {
    const localDaemonId = 'daemon_mach_1b46842a15d3409d96ad33e767a916dd'
    const foreignDaemonId = 'daemon_mach_84407c5a5e554421b06f1a42fc4ecca9'

    function multiPeerMeshNoPin() {
        return {
            id: 'mesh-multi',
            meshHost: { role: 'host', pairing: { status: 'not_configured' } },
            nodes: [
                { id: 'node-self', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' },
                { id: 'node-moltbot', daemonId: foreignDaemonId },
            ],
        }
    }

    it('does NOT synthesize a self host pin when the mesh has another daemon attached', () => {
        const status = resolveMeshHostStatus(multiPeerMeshNoPin(), { localDaemonId })
        expect(status.role).toBe('host')
        // No persisted pin + a foreign peer exists → host is unknown, not "me".
        expect(status.hostDaemonId).toBeUndefined()
        expect(status.hostNodeId).toBeUndefined()
    })

    it('marks an unresolved multi-peer host as not synthesized', () => {
        const status = resolveMeshHostStatus(multiPeerMeshNoPin(), { localDaemonId })
        expect(status.hostSynthesized).toBeFalsy()
    })

    it('gives every peer the SAME answer on a pin-less multi-peer mesh (no split brain)', () => {
        const mesh = multiPeerMeshNoPin()
        const fromLocal = resolveMeshHostStatus(mesh, { localDaemonId })
        const fromForeign = resolveMeshHostStatus(mesh, { localDaemonId: foreignDaemonId })
        expect(fromLocal.hostDaemonId).toBe(fromForeign.hostDaemonId)
        expect(fromLocal.hostDaemonId).toBeUndefined()
    })

    it('still synthesizes for a single-daemon / standalone mesh (the original first-setup case)', () => {
        const mesh = {
            meshHost: { role: 'host', pairing: { status: 'not_configured' } },
            nodes: [{ id: 'node-self', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' }],
        }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(localDaemonId)
        expect(status.hostNodeId).toBe('node-self')
        expect(status.hostSynthesized).toBe(true)
    })

    it('still synthesizes for a brand-new mesh with no nodes at all', () => {
        const mesh = { meshHost: { role: 'host', pairing: { status: 'not_configured' } }, nodes: [] }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(localDaemonId)
        expect(status.hostSynthesized).toBe(true)
    })

    it('honours an explicitly persisted pin even on a multi-peer mesh (never synthesized)', () => {
        const mesh = {
            ...multiPeerMeshNoPin(),
            meshHost: { role: 'host', hostDaemonId: foreignDaemonId, pairing: { status: 'not_configured' } },
        }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(foreignDaemonId)
        expect(status.hostSynthesized).toBeFalsy()
    })

    it('honours a persisted hostNodeId-only pin on a multi-peer mesh', () => {
        const mesh = {
            ...multiPeerMeshNoPin(),
            meshHost: { role: 'host', hostNodeId: 'node-moltbot', pairing: { status: 'not_configured' } },
        }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostNodeId).toBe('node-moltbot')
        expect(status.hostSynthesized).toBeFalsy()
    })

    it('treats a role:host node declaration as an authoritative pin, not a synthesis', () => {
        // add_mesh_node persists role:'host' on the host node; that is a daemon-side
        // declaration and must win over the local-self default on a multi-peer mesh.
        const mesh = {
            meshHost: { role: 'host', pairing: { status: 'not_configured' } },
            nodes: [
                { id: 'node-self', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' },
                { id: 'node-moltbot', daemonId: foreignDaemonId, role: 'host' },
            ],
        }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.hostDaemonId).toBe(foreignDaemonId)
        expect(status.hostNodeId).toBe('node-moltbot')
        expect(status.hostSynthesized).toBeFalsy()
    })

    it('ignores foreign-node detection for a member mesh (never synthesizes either way)', () => {
        const mesh = { ...multiPeerMeshNoPin(), meshHost: { role: 'member', pairing: { status: 'not_configured' } } }
        const status = resolveMeshHostStatus(mesh, { localDaemonId })
        expect(status.role).toBe('member')
        expect(status.hostDaemonId).toBeUndefined()
        expect(status.canOwnCoordinator).toBe(false)
    })

    it('reproduces the observed ~/.adhdev/meshes.json shape: no peer claims the host', () => {
        // Verbatim shape of the real mesh the operator saw flip between M1-Server
        // (moltbot) and the local Mac: role:'host', NO hostDaemonId, three distinct
        // daemons, no node flagged role:'host'. Note node_f23f… has no daemonId at all
        // (an unbound node) and must not be mistaken for a foreign peer or a self node.
        const mesh = {
            id: 'mesh_1d74794b83f4484bb3493f26edcd8bdb',
            name: 'adhdev',
            meshHost: { role: 'host', pairing: { status: 'not_configured' } },
            nodes: [
                { id: 'node_f1f8a825cc5846efbd3439eae2164e2d', daemonId: 'daemon_mach_1b46842a15d3409d96ad33e767a916dd' },
                { id: 'node_84407c5a5e554421b06f1a42fc4ecca9', daemonId: 'daemon_mach_b6c8b6b43cee431f94b42d2298c86aca' },
                { id: 'node_9939a4d239fd42deb131e61620135b9c', daemonId: 'daemon_mach_85ddf17a2aeb44ad9756c34fba12a916' },
                { id: 'node_f23f1098e223438ead12294ea5c4d486' },
                { id: 'node_9953516fc1fb45d78a30ab96409d05b5', daemonId: 'daemon_mach_1b46842a15d3409d96ad33e767a916dd' },
            ],
        }
        const mac = 'daemon_mach_1b46842a15d3409d96ad33e767a916dd'
        const moltbot = 'daemon_mach_b6c8b6b43cee431f94b42d2298c86aca'
        const third = 'daemon_mach_85ddf17a2aeb44ad9756c34fba12a916'
        // Before the guard each of these returned its own id — which is exactly why the
        // badge changed depending on which daemon answered mesh_status.
        for (const id of [mac, moltbot, third]) {
            const status = resolveMeshHostStatus(mesh, { localDaemonId: id })
            expect(status.hostDaemonId).toBeUndefined()
            expect(status.hostSynthesized).toBeFalsy()
        }
    })

    it('does not regress queue ownership: role drives requireMeshHostQueueOwner, not the pin', () => {
        const status = resolveMeshHostStatus(multiPeerMeshNoPin(), { localDaemonId })
        // Unresolved host pin must NOT downgrade a host-role daemon's queue ownership —
        // requireMeshHostQueueOwner keys off role only.
        expect(status.canOwnQueue).toBe(true)
        expect(() => requireMeshHostQueueOwner({ ownerRole: status.role })).not.toThrow()
        expect(() => requireMeshHostQueueOwner({ ownerRole: 'member' })).toThrow()
    })
})
