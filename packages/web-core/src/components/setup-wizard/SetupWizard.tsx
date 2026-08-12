/**
 * SetupWizard — the 5-step guided mesh setup shell.
 *
 *   1 machines   → pick/create the mesh, attach machines (commits immediately —
 *                  later steps need real node ids)
 *   2 slots      → per-node capability slots        (staged)
 *   3 scheduling → Smart / In order distribution    (staged)
 *   4 quota      → quota-aware routing thresholds   (staged)
 *   5 approvals  → approval/safety policy           (staged) + provider auto-approve
 *
 * Deliberately DUMB (DashboardNewSessionDialog model): no context imports — the
 * host injects sendCommand/unwrapResult/normalizeMesh/features/daemons as props
 * and, for the zero-machine state, its own install/pair surface via
 * renderInstallOnboarding (web-core cannot import web-cloud, so cloud passes
 * DashboardOnboarding in; standalone omits it).
 *
 * Commit model: step 1 writes immediately (create_mesh/add_mesh_node); steps
 * 2–5 only stage into the draft and are applied together on Finish by
 * runWizardPolicyCommit (wizardCommit.ts). Every staged field resolves to a
 * shipped daemon default when skipped, so partial completion is safe: step 1
 * is the only mandatory step, because every later write targets a mesh.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared'
import type { RepoMeshQuotaRoutingPolicy } from '@adhdev/daemon-core'
import type { RepoMeshDaemonEntry, RepoMeshFeatures } from '../../context/RepoMeshContext'
import { runMeshCreateSequence, useMeshList } from '../../pages/repo-mesh/useMeshList'
import {
    readMeshPolicy,
    strategyToDistribution,
    type MeshDistribution,
    type MeshEntry,
    type MeshNode,
} from '../../pages/repo-mesh/types'
import {
    buildProvidersByDaemonId,
    collectMeshProviderInventory,
    resolveNodeAvailableProviders,
} from '../../pages/repo-mesh/node-providers'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
} from '../../utils/provider-priority'
import MachinesStep from './MachinesStep'
import SlotsStep from './SlotsStep'
import SchedulingStep from './SchedulingStep'
import QuotaPolicyStep from './QuotaPolicyStep'
import ApprovalsStep from './ApprovalsStep'
import { runWizardPolicyCommit, type WizardPolicyCommitResult } from './wizardCommit'

export interface SetupWizardProps {
    daemons: RepoMeshDaemonEntry[]
    features: RepoMeshFeatures
    userName?: string
    sendCommand: (daemonId: string, type: string, payload?: any) => Promise<any>
    /** Cloud: raw?.result ?? raw. Standalone: identity. */
    unwrapResult: (raw: any) => any
    /** Normalize a raw mesh record (cloud normalization; standalone: identity). */
    normalizeMesh: (raw: any, sourceDaemonId: string) => any
    /** Optional metadata freshener for the create picker's held-first SWR. */
    loadDaemonMetadata?: (daemonId: string, opts?: { force?: boolean; minFreshMs?: number }) => void | Promise<unknown>
    /** Preselect this mesh (e.g. deep-linked from the mesh page). */
    initialMeshId?: string | null
    onClose: () => void
    /** Platform install/pair surface for the zero-machine state (cloud: DashboardOnboarding). */
    renderInstallOnboarding?: () => ReactNode
}

const STEP_IDS = ['machines', 'slots', 'scheduling', 'quota', 'approvals'] as const
type StepId = typeof STEP_IDS[number]

function daemonLabel(d: RepoMeshDaemonEntry): string {
    return d.machineNickname || d.nickname || d.hostname || d.user?.name || d.id
}

function nodeLabel(node: MeshNode): string {
    const n = node as any
    return n.machine_label || n.machineLabel || n.hostname || String(node.workspace || '').split(/[\\/]/).filter(Boolean).pop() || node.id
}

export default function SetupWizard({
    daemons,
    features,
    sendCommand,
    unwrapResult,
    normalizeMesh,
    loadDaemonMetadata,
    initialMeshId,
    onClose,
    renderInstallOnboarding,
}: SetupWizardProps) {
    const { t } = useTranslation('common')
    const primaryDaemonId = daemons[0]?.id || ''

    // ── Mesh list (shared hook — props-driven, no context) ──────────
    const {
        meshes,
        loading: meshesLoading,
        error: listError,
        setError,
        loadMeshes,
        selectedMeshId,
        setSelectedMeshId,
    } = useMeshList({
        daemons,
        primaryDaemonId,
        sendCommand,
        unwrapResult,
        normalizeMesh,
        features: { createDaemonPicker: features.createDaemonPicker, addNodeDaemonPicker: features.addNodeDaemonPicker },
        loadDaemonMetadata,
    })

    useEffect(() => {
        void loadMeshes()
    }, [loadMeshes])

    // Preselect: deep-linked mesh, or the single existing mesh. Never overrides
    // an explicit user choice (only fires while nothing is selected).
    useEffect(() => {
        if (selectedMeshId || meshes.length === 0) return
        if (initialMeshId && meshes.some(m => m.id === initialMeshId)) {
            setSelectedMeshId(initialMeshId)
        } else if (meshes.length === 1) {
            setSelectedMeshId(meshes[0].id)
        }
    }, [meshes, selectedMeshId, initialMeshId, setSelectedMeshId])

    const selectedMesh = useMemo(
        () => meshes.find(m => m.id === selectedMeshId) ?? null,
        [meshes, selectedMeshId],
    )
    const nodes: MeshNode[] = useMemo(() => selectedMesh?.nodes || [], [selectedMesh])
    const targetDaemonId = useCallback(
        (mesh: MeshEntry | null) => (mesh as any)?.__sourceDaemonId || primaryDaemonId,
        [primaryDaemonId],
    )

    // ── Wizard navigation ───────────────────────────────────────────
    const [stepIndex, setStepIndex] = useState(0)
    const step: StepId = STEP_IDS[stepIndex]

    // ── Step 1: create form ─────────────────────────────────────────
    const [createMode, setCreateMode] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createDaemonId, setCreateDaemonId] = useState('')
    const [createWorkspace, setCreateWorkspace] = useState('')
    const [createPlan, setCreatePlan] = useState<any>(null)
    const [createPlanLoading, setCreatePlanLoading] = useState(false)
    const [creating, setCreating] = useState(false)
    const [createWarning, setCreateWarning] = useState<string | null>(null)

    const resolvedCreateDaemonId = features.createDaemonPicker ? (createDaemonId || primaryDaemonId) : primaryDaemonId
    const createDaemon = useMemo(
        () => daemons.find(d => d.id === resolvedCreateDaemonId),
        [daemons, resolvedCreateDaemonId],
    )
    const createPickerWorkspaces = createDaemon?.workspaces || []

    // Create probe: git-aware dry-run on the owning daemon (auto-fills the
    // mesh name from discovery). Mirrors useMeshList's create probe, but fires
    // for standalone too — the wizard always creates mesh + first node in one
    // go, so it needs the plan either way.
    useEffect(() => {
        if (!createMode || !resolvedCreateDaemonId || !createWorkspace.trim()) {
            setCreatePlan(null)
            return
        }
        let cancelled = false
        setCreatePlanLoading(true)
        void sendCommand(resolvedCreateDaemonId, 'plan_mesh_onboarding', {
            workspace: createWorkspace.trim(),
            operation: 'auto',
            meshInventory: meshes,
        }).then(raw => {
            if (cancelled) return
            const result = unwrapResult(raw)
            setCreatePlan(result)
            if (result?.success) {
                setCreateName(current => current || `${String(result.discovery?.repoIdentity || result.discovery?.repoRoot || '').split(/[\\/]/).filter(Boolean).pop() || 'repo'}-mesh`)
            }
        }).catch(error => {
            if (!cancelled) setCreatePlan({ success: false, error: error?.message || 'Git discovery failed' })
        }).finally(() => {
            if (!cancelled) setCreatePlanLoading(false)
        })
        return () => { cancelled = true }
    }, [createMode, resolvedCreateDaemonId, createWorkspace, meshes, sendCommand, unwrapResult])

    const handleCreate = useCallback(async () => {
        const target = resolvedCreateDaemonId
        if (!target || !createName.trim() || !createWorkspace.trim() || creating) return
        setCreating(true)
        setCreateWarning(null)
        setError(null)
        try {
            const outcome = await runMeshCreateSequence({
                targetDaemonId: target,
                name: createName,
                repoRemoteUrl: '',
                repoIdentity: '',
                workspace: createWorkspace.trim(),
                attachWorkspace: true,
                machineId: createDaemon?.machineId,
                providerPriority: defaultProviderPriorityFromInventory(
                    normalizeAvailableCliProviders((createDaemon as any)?.availableProviders || [])),
                meshInventory: meshes,
                sendCommand,
                unwrapResult,
            })
            if (outcome.warning) setCreateWarning(outcome.warning)
            if (!outcome.meshCreated) {
                setError(outcome.error || t('setupWizard.machines.createFailed'))
                return
            }
            await loadMeshes(true)
            if (outcome.meshId) setSelectedMeshId(outcome.meshId)
            setCreateMode(false)
        } finally {
            setCreating(false)
        }
    }, [resolvedCreateDaemonId, createName, createWorkspace, creating, createDaemon, meshes, sendCommand, unwrapResult, loadMeshes, setSelectedMeshId, setError, t])

    // ── Step 1: attach form (plan_mesh_onboarding → add_mesh_node, the
    //    MeshNodeList add-node sequence, committed immediately so steps 2–5
    //    see real node ids) ──────────────────────────────────────────
    const [attachDaemonId, setAttachDaemonId] = useState('')
    const [attachWorkspace, setAttachWorkspace] = useState('')
    const [attachPlan, setAttachPlan] = useState<any>(null)
    const [attachPlanLoading, setAttachPlanLoading] = useState(false)
    const [attaching, setAttaching] = useState(false)

    const attachableDaemons = useMemo(() => {
        if (!features.addNodeDaemonPicker) return []
        const attached = new Set(nodes.map(n => String((n as any).daemon_id || (n as any).daemonId || '')))
        return daemons.filter(d => d.id && !attached.has(d.id))
    }, [features.addNodeDaemonPicker, nodes, daemons])

    const attachDaemon = useMemo(
        () => daemons.find(d => d.id === attachDaemonId),
        [daemons, attachDaemonId],
    )
    const attachPickerWorkspaces = features.addNodeDaemonPicker
        ? (attachDaemon?.workspaces || [])
        : (daemons.find(d => d.id === primaryDaemonId)?.workspaces || [])

    useEffect(() => {
        if (createMode || !selectedMeshId || !attachWorkspace.trim()) {
            setAttachPlan(null)
            return
        }
        const planDaemonId = features.addNodeDaemonPicker ? attachDaemonId : targetDaemonId(selectedMesh)
        if (!planDaemonId) return
        let cancelled = false
        setAttachPlanLoading(true)
        void sendCommand(planDaemonId, 'plan_mesh_onboarding', {
            workspace: attachWorkspace.trim(),
            meshId: selectedMeshId,
            inlineMesh: selectedMesh,
            operation: 'add_existing',
        }).then(raw => {
            if (!cancelled) setAttachPlan(unwrapResult(raw))
        }).catch(error => {
            if (!cancelled) setAttachPlan({ success: false, error: error?.message || 'Git discovery failed' })
        }).finally(() => {
            if (!cancelled) setAttachPlanLoading(false)
        })
        return () => { cancelled = true }
    }, [createMode, selectedMeshId, selectedMesh, attachWorkspace, attachDaemonId, features.addNodeDaemonPicker, targetDaemonId, sendCommand, unwrapResult])

    const handleAttach = useCallback(async () => {
        const target = targetDaemonId(selectedMesh)
        if (!selectedMeshId || !target || attaching) return
        const ws = attachWorkspace.trim()
        if (!ws) return
        setAttaching(true)
        setError(null)
        try {
            const planDaemonId = features.addNodeDaemonPicker ? attachDaemonId : target
            const planRaw = await sendCommand(planDaemonId, 'plan_mesh_onboarding', {
                workspace: ws,
                meshId: selectedMeshId,
                inlineMesh: selectedMesh,
                operation: 'add_existing',
            })
            const plan = unwrapResult(planRaw)
            setAttachPlan(plan)
            if (plan?.success === false) {
                throw new Error(`${plan.code || 'onboarding_blocked'}: ${plan.error}${plan.action ? ` ${plan.action}` : ''}`)
            }
            const payload: any = {
                meshId: selectedMeshId,
                workspace: plan?.discovery?.repoRoot || ws,
                repoRoot: plan?.discovery?.repoRoot,
                isLocalWorktree: plan?.discovery?.isLinkedWorktree === true,
            }
            if (features.addNodeDaemonPicker && attachDaemonId) {
                payload.daemonId = attachDaemonId
                payload.machineId = attachDaemon?.machineId
            }
            payload.providerPriority = defaultProviderPriorityFromInventory(
                normalizeAvailableCliProviders(((features.addNodeDaemonPicker ? attachDaemon : daemons[0]) as any)?.availableProviders || []))
            const raw = await sendCommand(target, 'add_mesh_node', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Add node failed')
            setAttachWorkspace('')
            setAttachPlan(null)
            await loadMeshes(true)
        } catch (e: any) {
            setError(e?.message || 'Add node failed')
        } finally {
            setAttaching(false)
        }
    }, [selectedMesh, selectedMeshId, attachWorkspace, attachDaemonId, attachDaemon, attaching, features.addNodeDaemonPicker, targetDaemonId, daemons, sendCommand, unwrapResult, loadMeshes, setError])

    // ── Steps 2–5: staged draft ─────────────────────────────────────
    const [stagedSlots, setStagedSlots] = useState<Record<string, NodeCapabilitySlot[]>>({})
    const [distribution, setDistribution] = useState<MeshDistribution | null>(null)
    const [approvalPatch, setApprovalPatch] = useState<Record<string, unknown>>({})
    const [quotaRouting, setQuotaRouting] = useState<RepoMeshQuotaRoutingPolicy | null>(null)

    const policy = useMemo(() => readMeshPolicy(selectedMesh), [selectedMesh])
    const anyNodePriorityConfigured = nodes.some(n => n.policy?.schedulingPriority !== undefined)
    const currentDistribution = distribution ?? strategyToDistribution(policy.schedulingStrategy, { priorityConfigured: anyNodePriorityConfigured })
    const recommendedDistribution: MeshDistribution | null = nodes.some(n => (n.policy?.slots || []).length > 0) ? 'smart' : null

    const providersByNodeId = useMemo(() => {
        const byDaemon = buildProvidersByDaemonId(daemons)
        const out: Record<string, ReturnType<typeof resolveNodeAvailableProviders>> = {}
        for (const node of nodes) out[node.id] = resolveNodeAvailableProviders(node, byDaemon)
        return out
    }, [nodes, daemons])

    // Provider auto-approve bundle (step 5) — only when a host node resolves.
    const [savingPolicy, setSavingPolicy] = useState(false)
    const handleImmediatePolicyUpdate = useCallback(async (patch: Record<string, unknown>) => {
        if (!selectedMesh) return
        const target = targetDaemonId(selectedMesh)
        try {
            setSavingPolicy(true)
            setError(null)
            const raw = await sendCommand(target, 'update_mesh', { meshId: selectedMesh.id, policy: { ...readMeshPolicy(selectedMesh), ...patch } })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Policy update failed')
            await loadMeshes(true)
        } catch (e: any) {
            setError(e?.message || 'Policy update failed')
        } finally {
            setSavingPolicy(false)
        }
    }, [selectedMesh, targetDaemonId, sendCommand, unwrapResult, loadMeshes, setError])

    const autoApprove = useMemo(() => {
        if (!selectedMesh) return null
        const hostDaemonId = targetDaemonId(selectedMesh)
        const hostNode = nodes.find(n => daemonIdsEquivalent(String((n as any).daemon_id || (n as any).daemonId || ''), hostDaemonId))
            || nodes.find(n => (n as any).role === 'host')
            || nodes[0]
        const hostWorkspace = hostNode?.workspace || ''
        if (!hostWorkspace) return null
        const inventory = collectMeshProviderInventory(nodes, daemons)
        return {
            hostDaemonId,
            hostOnline: daemons.some(d => d.id === hostDaemonId),
            hostWorkspace,
            meshProviders: inventory.providers,
            unreportedNodeCount: inventory.unreportedNodeCount,
            machineAutoApproveEnabled: policy.delegatedWorkerAutoApprove !== false,
            machineDangerousAllowed: policy.delegatedWorkerDangerousModeAllow === true,
            onUpdatePolicy: handleImmediatePolicyUpdate,
            savingPolicy,
            sendCommand,
        }
    }, [selectedMesh, nodes, daemons, policy, targetDaemonId, handleImmediatePolicyUpdate, savingPolicy, sendCommand])

    // ── Final commit ────────────────────────────────────────────────
    const [committing, setCommitting] = useState(false)
    const [commitResult, setCommitResult] = useState<WizardPolicyCommitResult | null>(null)

    const handleFinish = useCallback(async () => {
        if (!selectedMesh || committing) return
        setCommitting(true)
        setCommitResult(null)
        try {
            const result = await runWizardPolicyCommit({
                sendCommand,
                unwrapResult,
                targetDaemonId: targetDaemonId(selectedMesh),
                meshId: selectedMesh.id,
                currentPolicy: readMeshPolicy(selectedMesh),
                slotsByNodeId: stagedSlots,
                distribution,
                approvalPatch: Object.keys(approvalPatch).length > 0 ? approvalPatch : null,
                quotaRouting,
            })
            setCommitResult(result)
            await loadMeshes(true)
        } finally {
            setCommitting(false)
        }
    }, [selectedMesh, committing, sendCommand, unwrapResult, targetDaemonId, stagedSlots, distribution, approvalPatch, quotaRouting, loadMeshes])

    // ── Skip semantics: discard THIS step's staged draft and advance.
    //    Steps 2–5 only stage; nothing is written until Finish, so skipping is
    //    always safe (daemon defaults/current values stay untouched). ──
    const clearStepDraft = useCallback((id: StepId) => {
        if (id === 'slots') setStagedSlots({})
        else if (id === 'scheduling') setDistribution(null)
        else if (id === 'quota') setQuotaRouting(null)
        else if (id === 'approvals') setApprovalPatch({})
    }, [])

    const canGoNext = step !== 'machines'
        || (daemons.length > 0 && !createMode && !!selectedMeshId)
    const goNext = () => { if (canGoNext && stepIndex < STEP_IDS.length - 1) setStepIndex(stepIndex + 1) }
    const goBack = () => { if (stepIndex > 0) setStepIndex(stepIndex - 1) }
    const goSkip = () => {
        clearStepDraft(step)
        if (stepIndex < STEP_IDS.length - 1) setStepIndex(stepIndex + 1)
    }

    // "Done" only on a clean commit — a partial failure keeps the Finish
    // button available so the user can retry after reading the stage errors.
    const done = commitResult?.ok === true

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
            {/* Header + progress */}
            <div>
                <h2 className="text-base font-semibold text-text-primary">{t('setupWizard.title')}</h2>
                <div className="mt-2 flex items-center gap-1.5">
                    {STEP_IDS.map((id, i) => (
                        <div
                            key={id}
                            className={`h-1.5 flex-1 rounded-full ${i < stepIndex ? 'bg-accent-primary' : i === stepIndex ? 'bg-accent-primary/60' : 'bg-border-subtle'}`}
                            title={t(`setupWizard.steps.${id}`)}
                        />
                    ))}
                </div>
                <p className="mt-1.5 text-[11px] text-text-muted">
                    {t('setupWizard.stepOf', { current: stepIndex + 1, total: STEP_IDS.length })}
                    {' · '}
                    {t(`setupWizard.steps.${step}`)}
                </p>
            </div>

            {(listError && !done) && <p className="text-[11px] text-red-400">{listError}</p>}

            {/* Step body */}
            <div className="rounded-xl border border-border-subtle bg-bg-primary p-4">
                {step === 'machines' && (
                    <MachinesStep
                        daemons={daemons}
                        features={features}
                        meshes={meshes}
                        meshesLoading={meshesLoading}
                        selectedMeshId={selectedMeshId}
                        onSelectMesh={id => { setSelectedMeshId(id); setAttachWorkspace(''); setAttachDaemonId('') }}
                        createMode={createMode}
                        onCreateModeChange={setCreateMode}
                        createName={createName}
                        onCreateNameChange={setCreateName}
                        createDaemonId={createDaemonId}
                        onCreateDaemonIdChange={setCreateDaemonId}
                        createWorkspace={createWorkspace}
                        onCreateWorkspaceChange={setCreateWorkspace}
                        createPickerWorkspaces={createPickerWorkspaces}
                        createPlan={createPlan}
                        createPlanLoading={createPlanLoading}
                        creating={creating}
                        createWarning={createWarning}
                        onCreate={handleCreate}
                        nodes={nodes}
                        attachableDaemons={attachableDaemons}
                        attachDaemonId={attachDaemonId}
                        onAttachDaemonIdChange={id => { setAttachDaemonId(id); setAttachWorkspace('') }}
                        attachWorkspace={attachWorkspace}
                        onAttachWorkspaceChange={setAttachWorkspace}
                        attachPickerWorkspaces={attachPickerWorkspaces}
                        attachPlan={attachPlan}
                        attachPlanLoading={attachPlanLoading}
                        attaching={attaching}
                        onAttach={handleAttach}
                        renderInstallOnboarding={renderInstallOnboarding}
                        nodeLabel={nodeLabel}
                        daemonLabel={daemonLabel}
                    />
                )}
                {step === 'slots' && selectedMesh && (
                    <SlotsStep
                        nodes={nodes}
                        providersByNodeId={providersByNodeId}
                        stagedSlots={stagedSlots}
                        onStageSlots={(nodeId, slots) => setStagedSlots(prev => ({ ...prev, [nodeId]: slots }))}
                        nodeLabel={nodeLabel}
                    />
                )}
                {step === 'scheduling' && selectedMesh && (
                    <SchedulingStep
                        value={currentDistribution}
                        onChange={setDistribution}
                        recommended={recommendedDistribution}
                    />
                )}
                {step === 'quota' && selectedMesh && (
                    <>
                        <QuotaPolicyStep
                            quotaRouting={policy.quotaRouting ?? null}
                            onSave={setQuotaRouting}
                        />
                        {quotaRouting !== null && (
                            <p className="mt-2 text-[10px] text-accent-primary">{t('setupWizard.staged')} — {t('setupWizard.stagedNote')}</p>
                        )}
                    </>
                )}
                {step === 'approvals' && selectedMesh && (
                    <ApprovalsStep
                        policy={policy}
                        stagedPatch={approvalPatch}
                        onStage={patch => setApprovalPatch(prev => ({ ...prev, ...patch }))}
                        autoApprove={autoApprove}
                    />
                )}

                {/* Commit result */}
                {commitResult && (
                    <div className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary/60 px-3 py-2.5">
                        {commitResult.ok ? (
                            <p className="text-[12px] text-emerald-400">
                                {commitResult.applied.length > 0
                                    ? t('setupWizard.finish.applied', { count: commitResult.applied.length })
                                    : t('setupWizard.finish.nothingToApply')}
                            </p>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <p className="text-[12px] text-red-400">{t('setupWizard.finish.partialFailure')}</p>
                                {commitResult.errors.map((e, i) => (
                                    <p key={i} className="text-[11px] text-red-400">· {e.stage}{e.nodeId ? ` (${e.nodeId})` : ''}: {e.message}</p>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2">
                {!done && stepIndex > 0 && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={goBack}>
                        {t('setupWizard.back')}
                    </button>
                )}
                {!done && stepIndex > 0 && stepIndex < STEP_IDS.length - 1 && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={goSkip}>
                        {t('setupWizard.skip')}
                    </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {!done && stepIndex < STEP_IDS.length - 1 && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={goNext} disabled={!canGoNext}>
                            {t('setupWizard.next')}
                        </button>
                    )}
                    {!done && stepIndex === STEP_IDS.length - 1 && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={handleFinish} disabled={committing || !selectedMesh}>
                            {committing ? t('setupWizard.finish.applying') : t('setupWizard.finish.apply')}
                        </button>
                    )}
                    {done && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
                            {t('setupWizard.close')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
