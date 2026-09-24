import { describe, expect, it, vi } from 'vitest'

import { DaemonCommandRouter } from '../../src/commands/router'
import { resolveDryRunVeto } from '../../src/commands/command-args'

/**
 * DRY-RUN-VETO-PRECEDENCE (safety) — pins the fix for a real safety bug found
 * in a parity audit: `isDryRun = dryRun !== false && execute !== true` computed
 * `false` for `{execute:true, dryRun:true}` (`true !== false` is `true`, but
 * ANDed with `execute !== true` being `false` flips the whole expression to
 * `false`), so a caller asking for a dry run alongside execute:true silently
 * got the REAL validate→merge→push job instead of a preview. A bare
 * `dry_run:false` with no `execute:true` was also silently executed instead of
 * refused, unlike the sibling `mesh_fast_forward_node` contract
 * (`dry_run_false_requires_execute`, mesh-tools-git.ts).
 *
 * `resolveDryRunVeto` (command-args.ts) is now the single source of this
 * precedence, consumed by both med-family/fast-forward.ts (refine_mesh_node,
 * batch_refine_mesh_nodes) and router-refine-batch-jobs.ts's defence-in-depth
 * sites (batchRefineMeshNodes, startMeshRefineBatchJob).
 */

// Build a router with a local (non-remote) node so refine_mesh_node /
// batch_refine_mesh_nodes never forward and reach the med-family handler's
// dry-run/execute precedence directly. The veto/refusal short-circuits BEFORE
// any git or mesh-lookup work, so a minimal inline mesh is sufficient.
function createRouter() {
    return new DaemonCommandRouter({
        commandHandler: { handle: async () => ({ success: false }) } as any,
        cliManager: {} as any,
        cdpManagers: new Map(),
        providerLoader: {} as any,
        instanceManager: {
            collectAllStates: () => [],
            listInstanceIds: () => [],
            getInstance: () => null,
            getByCategory: () => [],
        } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
        packageName: 'adhdev',
        statusVersion: '0.9.76',
        statusInstanceId: 'daemon-local',
    } as any)
}

function meshWith(nodes: any[]) {
    return {
        id: 'mesh-dry-run-veto',
        name: 'Dry Run Veto Mesh',
        repoIdentity: 'example/repo',
        defaultBranch: 'main',
        policy: {},
        coordinator: {},
        nodes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
}

const localNode = {
    id: 'node-local',
    workspace: '/local/machine/repo',
    repoRoot: '/local/machine/repo',
    daemonId: 'daemon-local',
    policy: {},
    userOverrides: {},
}

describe('resolveDryRunVeto (pure)', () => {
    it('BREAK-ONCE: dryRun:true wins even with execute:true (the exact input that used to execute for real)', () => {
        const result = resolveDryRunVeto({ execute: true, dryRun: true })
        expect(result).toMatchObject({ refused: false, isDryRun: true })
    })

    it('bare dryRun:false with no execute:true is refused, not silently executed', () => {
        const result = resolveDryRunVeto({ dryRun: false })
        expect(result).toMatchObject({ refused: true, code: 'dry_run_false_requires_execute' })
    })

    it('dryRun:false with execute:true executes', () => {
        const result = resolveDryRunVeto({ dryRun: false, execute: true })
        expect(result).toMatchObject({ refused: false, isDryRun: false })
    })

    it('dryRun undefined + execute:true executes', () => {
        expect(resolveDryRunVeto({ execute: true })).toMatchObject({ refused: false, isDryRun: false })
    })

    it('no args at all defaults to dry-run (plan-only)', () => {
        expect(resolveDryRunVeto(undefined)).toMatchObject({ refused: false, isDryRun: true })
        expect(resolveDryRunVeto({})).toMatchObject({ refused: false, isDryRun: true })
    })
})

describe('refine_mesh_node — dry_run/execute precedence (daemon-side)', () => {
    it('BREAK-ONCE: {execute:true, dry_run:true} returns a dry-run plan, never executes', async () => {
        const router = createRouter()
        const mesh = meshWith([localNode])

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-local',
            execute: true,
            dryRun: true,
            inlineMesh: mesh,
        })

        // Must be a dry-run response (mergeWillRun:false), never startMeshRefineJob's
        // real execution path.
        expect(result.dryRun).toBe(true)
        expect(result.mergeWillRun).toBe(false)
    })

    it('bare dry_run:false (no execute:true) is refused with dry_run_false_requires_execute', async () => {
        const router = createRouter()
        const mesh = meshWith([localNode])

        const result: any = await router.execute('refine_mesh_node', {
            meshId: mesh.id,
            nodeId: 'node-local',
            dryRun: false,
            inlineMesh: mesh,
        })

        expect(result.success).toBe(false)
        expect(result.code).toBe('dry_run_false_requires_execute')
        expect(result.executed).toBe(false)
        expect(result.willRun).toBe(false)
    })
})

describe('batch_refine_mesh_nodes — dry_run/execute precedence (daemon-side)', () => {
    it('BREAK-ONCE: {execute:true, dry_run:true} refuses to start the async execute job', async () => {
        const router = createRouter()
        const mesh = meshWith([localNode])

        // batchRefineMeshNodes (the dry-run path) does real ordering work against the
        // mesh's nodes; we only need to prove that startMeshRefineBatchJob (the
        // execute path) is never reached. Spy on the router's job starter.
        const startSpy = vi.spyOn(router as any, 'startMeshRefineBatchJob')

        const result: any = await router.execute('batch_refine_mesh_nodes', {
            meshId: mesh.id,
            execute: true,
            dryRun: true,
            inlineMesh: mesh,
        })

        expect(startSpy).not.toHaveBeenCalled()
        expect(result.dryRun).not.toBe(false)
    })

    it('bare dry_run:false (no execute:true) is refused with dry_run_false_requires_execute', async () => {
        const router = createRouter()
        const mesh = meshWith([localNode])

        const result: any = await router.execute('batch_refine_mesh_nodes', {
            meshId: mesh.id,
            dryRun: false,
            inlineMesh: mesh,
        })

        expect(result.success).toBe(false)
        expect(result.code).toBe('dry_run_false_requires_execute')
        expect(result.executed).toBe(false)
        expect(result.willRun).toBe(false)
    })
})
