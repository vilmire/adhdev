import { describe, expect, it, vi } from 'vitest'
import { runMeshCreateSequence } from '../../src/pages/repo-mesh/useMeshList'

/**
 * MESH-CREATE-LIST-REFRESH regression.
 *
 * The reported bug: creating a mesh appeared to do nothing — the mesh was absent from
 * the list even though the daemon had persisted it. Root cause was in this sequence:
 * `add_mesh_node` failing after a SUCCESSFUL `create_mesh` aborted the caller before it
 * could refresh the list or close the create form.
 *
 * The load-bearing invariant these tests pin: once `create_mesh` succeeds,
 * `meshCreated` is true no matter what the follow-up attach does, so the caller always
 * refreshes. An attach failure is reported as `warning`, never as `error`.
 */

const PLAN_OK = {
    success: true,
    plan: { kind: 'create_mesh_and_onboard' },
    discovery: { repoRoot: '/repo', repoIdentity: 'github.com/acme/repo', defaultBranch: 'main' },
}

const unwrapResult = (raw: any) => raw?.result ?? raw

function baseOptions(sendCommand: any) {
    return {
        targetDaemonId: 'daemon_1',
        name: 'acme-mesh',
        repoRemoteUrl: 'https://github.com/acme/repo.git',
        repoIdentity: '',
        workspace: '/repo',
        attachWorkspace: true,
        machineId: 'mach_1',
        providerPriority: ['claude-cli'],
        meshInventory: [],
        sendCommand,
        unwrapResult,
    }
}

/** Scripts a sendCommand double whose add_mesh_node reply is caller-supplied. */
function sendCommandWith(addReply: any | (() => never)) {
    return vi.fn(async (_daemonId: string, command: string) => {
        if (command === 'plan_mesh_onboarding') return PLAN_OK
        if (command === 'create_mesh') return { success: true, mesh: { id: 'mesh_abc' } }
        if (command === 'add_mesh_node') {
            if (typeof addReply === 'function') return (addReply as () => never)()
            return addReply
        }
        throw new Error(`unexpected command ${command}`)
    })
}

describe('runMeshCreateSequence', () => {
    it('reports the mesh as created and returns its id on the happy path', async () => {
        const sendCommand = sendCommandWith({ success: true, node: { id: 'node_1' } })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(true)
        expect(outcome.meshId).toBe('mesh_abc')
        expect(outcome.error).toBeNull()
        expect(outcome.warning).toBeNull()
    })

    it('keeps the mesh created when add_mesh_node returns success:false (the reported bug)', async () => {
        const sendCommand = sendCommandWith({ success: false, error: 'This workspace is already in the mesh' })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        // The regression: this MUST stay true so the caller refreshes the list and
        // closes the form. Before the fix the add failure aborted the whole create.
        expect(outcome.meshCreated).toBe(true)
        expect(outcome.meshId).toBe('mesh_abc')
        // The attach failure is non-fatal and must not masquerade as a create failure...
        expect(outcome.error).toBeNull()
        // ...but it must not be swallowed either.
        expect(outcome.warning).toContain('This workspace is already in the mesh')
    })

    it('keeps the mesh created when add_mesh_node throws (transport failure)', async () => {
        const sendCommand = sendCommandWith(() => { throw new Error('P2P not connected') })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(true)
        expect(outcome.error).toBeNull()
        expect(outcome.warning).toContain('P2P not connected')
    })

    it('reports a fatal error and no creation when create_mesh itself fails', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') return PLAN_OK
            if (command === 'create_mesh') return { success: false, error: 'Maximum 20 meshes allowed' }
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(false)
        expect(outcome.error).toBe('Maximum 20 meshes allowed')
        expect(outcome.warning).toBeNull()
        // add_mesh_node must never run once the create failed.
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('add_mesh_node')
    })

    it('does not create when the onboarding plan is blocked', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') {
                return { success: false, code: 'dirty_worktree', error: 'Uncommitted changes', action: 'Commit first.' }
            }
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(false)
        expect(outcome.error).toContain('dirty_worktree')
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('create_mesh')
    })

    it('does not create a duplicate when a compatible mesh already exists', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') {
                return { success: true, plan: { kind: 'add_existing_workspace', summary: 'A compatible mesh already exists.' } }
            }
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(false)
        expect(outcome.error).toContain('compatible mesh already exists')
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('create_mesh')
    })

    it('skips the attach entirely when the caller has no workspace to attach', async () => {
        const sendCommand = sendCommandWith({ success: true, node: { id: 'node_1' } })

        const outcome = await runMeshCreateSequence({
            ...baseOptions(sendCommand),
            attachWorkspace: false,
        } as any)

        expect(outcome.meshCreated).toBe(true)
        expect(outcome.warning).toBeNull()
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('add_mesh_node')
    })

    it('reuses an already-fetched plan instead of re-querying plan_mesh_onboarding', async () => {
        // CREATE-FLOW-FLICKER: the create form already runs plan_mesh_onboarding as a
        // live discovery preview while the operator fills the form. Re-running it here
        // was a second, invisible round-trip with no loading indicator — the source of
        // a "looks good" → surprise error flip when the plan turned out to target an
        // existing mesh. Passing reusablePlan must skip that second fetch entirely.
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') throw new Error('should not re-fetch the plan')
            if (command === 'create_mesh') return { success: true, mesh: { id: 'mesh_abc' } }
            if (command === 'add_mesh_node') return { success: true, node: { id: 'node_1' } }
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence({
            ...baseOptions(sendCommand),
            reusablePlan: PLAN_OK,
        } as any)

        expect(outcome.meshCreated).toBe(true)
        expect(outcome.meshId).toBe('mesh_abc')
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('plan_mesh_onboarding')
    })

    it('rejects an existing-mesh reusablePlan the same way as a freshly fetched one', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') throw new Error('should not re-fetch the plan')
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence({
            ...baseOptions(sendCommand),
            reusablePlan: { success: true, plan: { kind: 'add_existing_workspace', summary: 'A compatible mesh already exists.' } },
        } as any)

        expect(outcome.meshCreated).toBe(false)
        expect(outcome.error).toContain('compatible mesh already exists')
        expect(sendCommand.mock.calls.map(c => c[1])).not.toContain('create_mesh')
    })

    it('unwraps daemon replies nested under result (cloud P2P envelope)', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, command: string) => {
            if (command === 'plan_mesh_onboarding') return { result: PLAN_OK }
            if (command === 'create_mesh') return { result: { success: true, mesh: { id: 'mesh_env' } } }
            if (command === 'add_mesh_node') return { result: { success: true, node: { id: 'node_1' } } }
            throw new Error(`unexpected command ${command}`)
        })

        const outcome = await runMeshCreateSequence(baseOptions(sendCommand) as any)

        expect(outcome.meshCreated).toBe(true)
        expect(outcome.meshId).toBe('mesh_env')
    })
})
