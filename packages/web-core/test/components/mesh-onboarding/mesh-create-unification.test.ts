/**
 * Mesh create form unification.
 *
 * The create form used to exist twice with DIFFERENT required fields depending
 * on the entry point: the mesh page refused to create without a hand-typed repo
 * remote URL or identity, while the setup wizard sent both empty and relied on
 * git discovery. Same daemon command, two contracts — a mesh you could create
 * from /setup was rejected from /mesh.
 *
 * These tests pin the unified rule so a re-divergence fails loudly:
 *   a workspace (which discovery reads) OR a manual identity/URL is enough.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMeshCreateDisabled } from '../../../src/components/mesh-onboarding/MeshCreateForm'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../../src', relativePath), 'utf8')
}

const base = {
    creating: false,
    planLoading: false,
    plan: { success: true },
    name: 'my-mesh',
    workspace: '/repo',
    showDaemonPicker: false,
    daemonId: '',
    repoRemoteUrl: '',
    repoIdentity: '',
}

describe('isMeshCreateDisabled', () => {
    it('allows create from a workspace alone — discovery supplies identity', () => {
        // This is the case the mesh page used to reject outright.
        expect(isMeshCreateDisabled(base)).toBe(false)
    })

    it('allows create from a manual identity when there is no workspace', () => {
        expect(isMeshCreateDisabled({ ...base, workspace: '', repoIdentity: 'github.com/u/r' })).toBe(false)
        expect(isMeshCreateDisabled({ ...base, workspace: '', repoRemoteUrl: 'https://github.com/u/r' })).toBe(false)
    })

    it('blocks when there is neither a workspace nor a manual identity', () => {
        expect(isMeshCreateDisabled({ ...base, workspace: '' })).toBe(true)
    })

    it('blocks on a failed discovery plan, an empty name, and in-flight state', () => {
        expect(isMeshCreateDisabled({ ...base, plan: { success: false } })).toBe(true)
        expect(isMeshCreateDisabled({ ...base, name: '   ' })).toBe(true)
        expect(isMeshCreateDisabled({ ...base, creating: true })).toBe(true)
        expect(isMeshCreateDisabled({ ...base, planLoading: true })).toBe(true)
    })

    it('requires a machine only when the daemon picker is shown (cloud)', () => {
        expect(isMeshCreateDisabled({ ...base, showDaemonPicker: true, daemonId: '' })).toBe(true)
        expect(isMeshCreateDisabled({ ...base, showDaemonPicker: true, daemonId: 'd1' })).toBe(false)
    })

    it('blocks when the plan targets an already-existing compatible mesh (CREATE-FLOW-FLICKER)', () => {
        // A successful plan whose kind isn't create_mesh_and_onboard always fails
        // server-side if submitted — block it here instead of letting the operator
        // click into a guaranteed error.
        expect(isMeshCreateDisabled({
            ...base,
            plan: { success: true, plan: { kind: 'add_existing_workspace' } },
        })).toBe(true)
        expect(isMeshCreateDisabled({
            ...base,
            plan: { success: true, plan: { kind: 'create_mesh_and_onboard' } },
        })).toBe(false)
    })
})

describe('create form single-implementation guards', () => {
    it('both entry points render the shared MeshCreateForm', () => {
        expect(readSource('pages/repo-mesh/MeshListView.tsx')).toContain('<MeshCreateForm')
        expect(readSource('components/setup-wizard/MachinesStep.tsx')).toContain('<MeshCreateForm')
    })

    it('the mesh page no longer hard-requires a typed identity or remote URL', () => {
        // The old gate. Its return is what made a discovery-only create impossible.
        expect(readSource('pages/repo-mesh/useMeshList.ts')).not.toContain('if (!remoteUrl && !identity) return')
    })

    it('create attaches the workspace on standalone too, not only when the cloud picker is on', () => {
        // attachWorkspace was gated on features.createDaemonPicker (cloud-only),
        // so a standalone create produced a mesh with no nodes.
        const source = readSource('pages/repo-mesh/useMeshList.ts')
        expect(source).not.toContain('attachWorkspace: features.createDaemonPicker')
        expect(source).toContain('attachWorkspace: !!workspace')
    })
})

describe('setup wizard is reduced to onboarding', () => {
    const wizard = readSource('components/setup-wizard/SetupWizard.tsx')

    it('mounts only the machines step', () => {
        expect(wizard).toContain('<MachinesStep')
        for (const gone of ['<SlotsStep', '<SchedulingStep', '<QuotaPolicyStep', '<ApprovalsStep']) {
            expect(wizard, `${gone} should no longer be mounted by the wizard`).not.toContain(gone)
        }
    })

    it('has no staged-draft commit path left', () => {
        // Steps 2-5 staged edits until one Finish commit; that whole model is gone.
        expect(wizard).not.toContain('runWizardPolicyCommit')
        expect(wizard).not.toContain('STEP_IDS')
    })

    it('still exposes the handoff to the mesh page', () => {
        expect(wizard).toContain('onClose')
        expect(wizard).toContain('continueToMesh')
    })
})
