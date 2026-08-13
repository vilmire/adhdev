/**
 * wizardCommit — the setup wizard's final-commit orchestration.
 *
 * The wizard shell collects each step's values into a draft (slots per node,
 * distribution mode, approval policy patch, quota-routing overrides) and, on
 * Finish, applies them here in dependency order:
 *
 *   1. per-node capability slots   — update_mesh_node { policy: { slots } }
 *   2. mesh policy patch           — update_mesh { policy } (scheduling strategy
 *                                    + approval flags merged over current policy)
 *   3. quota-routing overrides     — mesh_quota_routing_set { quotaRouting }
 *
 * Stages are independent: a stage with no staged data is skipped entirely, and a
 * failing stage does NOT abort the remaining ones — every failure is collected
 * and reported so a partial commit is explicit, never silent. This mirrors the
 * overrides-only persistence economy of the underlying writers (a skipped step
 * leaves the daemon defaults/current values untouched).
 *
 * Command sequence and error idiom mirror useMeshNodeActions.ts exactly
 * (unwrapResult + `success === false` → throw), so the two surfaces cannot
 * drift on how a write is issued.
 */
import type { RepoMeshQuotaRoutingPolicy } from '@adhdev/daemon-core'
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared'
import { distributionToStrategy, type MeshDistribution } from '../../pages/repo-mesh/types'

export type WizardCommitStage = 'slots' | 'policy' | 'quota'

export interface WizardCommitStageError {
    stage: WizardCommitStage
    /** Node id for slots-stage failures, so the user knows which machine failed. */
    nodeId?: string
    message: string
}

export interface WizardPolicyCommitOptions {
    sendCommand: (daemonId: string, type: string, payload?: any) => Promise<any>
    unwrapResult: (raw: any) => any
    /** Mesh host daemon — every mesh write routes here. */
    targetDaemonId: string
    meshId: string
    /** Current persisted policy (readMeshPolicy output) — the patch merges over it. */
    currentPolicy: Record<string, any>
    /** Step 2: node id → capability slots. Only staged nodes are written. */
    slotsByNodeId?: Record<string, NodeCapabilitySlot[]>
    /** Step 3: 2-mode distribution façade; mapped to the raw strategy on write. */
    distribution?: MeshDistribution | null
    /** Step 5: approval policy keys (checkpoint/push/dirty-workspace flags). */
    approvalPatch?: Record<string, unknown> | null
    /** Step 4: quota-routing overrides (`{}` clears every override). */
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null
}

export interface WizardPolicyCommitResult {
    /** True when every staged stage succeeded (or nothing was staged). */
    ok: boolean
    /** Stages that were actually written, in application order. */
    applied: WizardCommitStage[]
    errors: WizardCommitStageError[]
}

export async function runWizardPolicyCommit(opts: WizardPolicyCommitOptions): Promise<WizardPolicyCommitResult> {
    const { sendCommand, unwrapResult, targetDaemonId, meshId } = opts
    const applied: WizardCommitStage[] = []
    const errors: WizardCommitStageError[] = []

    const run = async (stage: WizardCommitStage, nodeId: string | undefined, fn: () => Promise<any>, fallback: string) => {
        try {
            const raw = await fn()
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || fallback)
            return true
        } catch (e: any) {
            errors.push({ stage, nodeId, message: e?.message || fallback })
            return false
        }
    }

    // 1. Per-node capability slots.
    const slotEntries = Object.entries(opts.slotsByNodeId || {})
    if (slotEntries.length > 0) {
        let allOk = true
        for (const [nodeId, slots] of slotEntries) {
            const ok = await run('slots', nodeId, () =>
                sendCommand(targetDaemonId, 'update_mesh_node', { meshId, nodeId, policy: { slots } }),
            'Node slots update failed')
            if (!ok) allOk = false
        }
        if (allOk) applied.push('slots')
    }

    // 2. Mesh policy patch — scheduling strategy + approval flags in ONE write,
    //    merged over the current policy exactly like MeshDetailView's onUpdatePolicy.
    const policyPatch: Record<string, unknown> = { ...(opts.approvalPatch || {}) }
    if (opts.distribution) policyPatch.schedulingStrategy = distributionToStrategy(opts.distribution)
    if (Object.keys(policyPatch).length > 0) {
        const nextPolicy = { ...(opts.currentPolicy || {}), ...policyPatch }
        const ok = await run('policy', undefined, () =>
            sendCommand(targetDaemonId, 'update_mesh', { meshId, policy: nextPolicy }),
        'Policy update failed')
        if (ok) applied.push('policy')
    }

    // 3. Quota-routing overrides (overrides-only persistence; `{}` clears).
    if (opts.quotaRouting) {
        const ok = await run('quota', undefined, () =>
            sendCommand(targetDaemonId, 'mesh_quota_routing_set', { meshId, quotaRouting: opts.quotaRouting }),
        'Quota policy save failed')
        if (ok) applied.push('quota')
    }

    return { ok: errors.length === 0, applied, errors }
}
