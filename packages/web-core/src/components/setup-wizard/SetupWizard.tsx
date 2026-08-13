/**
 * SetupWizard — first-run onboarding: create a mesh and attach machines.
 *
 * Scope is deliberately ONE step. It used to carry four more (slots,
 * scheduling, quota, approvals), each a second implementation of a control the
 * mesh page already owns — and a strictly worse one, because the wizard staged
 * every edit until a single Finish commit and offered no way to come back and
 * change one field. The mesh page edits the same policy in place, per field.
 * So onboarding now stops at the point where a mesh exists with machines on it
 * and hands off to /mesh, which is where those settings live and where the user
 * will return to change them. `onClose` is that handoff, and every host already
 * routes it to the mesh page.
 *
 * Deliberately DUMB (DashboardNewSessionDialog model): no context imports — the
 * host injects sendCommand/unwrapResult/normalizeMesh/features/daemons as props
 * and, for the zero-machine state, its own install/pair surface via
 * renderInstallOnboarding (web-core cannot import web-cloud, so cloud passes
 * DashboardOnboarding in; standalone omits it).
 *
 * Commit model: everything here writes immediately (create_mesh /
 * add_mesh_node). There is no staged draft and no Finish commit to lose.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshDaemonEntry, RepoMeshFeatures } from '../../context/RepoMeshContext'
import { runMeshCreateSequence, useMeshList } from '../../pages/repo-mesh/useMeshList'
import { type MeshEntry, type MeshNode } from '../../pages/repo-mesh/types'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
} from '../../utils/provider-priority'
import MachinesStep from './MachinesStep'

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

    // ── Create form ─────────────────────────────────────────────────
    const [createMode, setCreateMode] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createDaemonId, setCreateDaemonId] = useState('')
    const [createWorkspace, setCreateWorkspace] = useState('')
    const [createPlan, setCreatePlan] = useState<any>(null)
    const [createPlanLoading, setCreatePlanLoading] = useState(false)
    const [creating, setCreating] = useState(false)
    const [createWarning, setCreateWarning] = useState<string | null>(null)
    // Manual identity fallback — discovery fills these in, but a repo with no
    // remote has nothing to discover and still needs to be creatable here.
    const [createRepoRemoteUrl, setCreateRepoRemoteUrl] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')
    const [createManualOpen, setCreateManualOpen] = useState(false)

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
                setCreateRepoIdentity(current => current || result.discovery?.repoIdentity || '')
                setCreateRepoRemoteUrl(current => current || result.discovery?.origin?.urls?.[0] || result.discovery?.upstream?.urls?.[0] || '')
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
        const ws = createWorkspace.trim()
        const remoteUrl = createRepoRemoteUrl.trim()
        const identity = createRepoIdentity.trim()
        if (!target || !createName.trim() || creating) return
        if (!ws && !remoteUrl && !identity) return
        setCreating(true)
        setCreateWarning(null)
        setError(null)
        try {
            const outcome = await runMeshCreateSequence({
                targetDaemonId: target,
                name: createName,
                repoRemoteUrl: remoteUrl,
                repoIdentity: identity,
                workspace: ws,
                attachWorkspace: !!ws,
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
    }, [resolvedCreateDaemonId, createName, createWorkspace, createRepoRemoteUrl, createRepoIdentity, creating, createDaemon, meshes, sendCommand, unwrapResult, loadMeshes, setSelectedMeshId, setError, t])

    // ── Attach form (plan_mesh_onboarding → add_mesh_node — the same sequence
    //    as MeshNodeList's add-node flow, committed immediately) ─────
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

    // ── Render ──────────────────────────────────────────────────────
    // Onboarding is complete once a mesh exists with at least one node on it.
    // Everything past that point (slots, scheduling, quota, approvals) is edited
    // on the mesh page, in place, so we send the user there instead of staging a
    // second copy of those controls here.
    const meshReady = !createMode && !!selectedMesh && nodes.length > 0

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
            <div>
                <h2 className="text-base font-semibold text-text-primary">{t('setupWizard.title')}</h2>
                <p className="mt-1.5 text-[11px] text-text-muted">{t('setupWizard.machines.description')}</p>
            </div>

            {listError && <p className="text-[11px] text-red-400">{listError}</p>}

            <div className="rounded-xl border border-border-subtle bg-bg-primary p-4">
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
                    createRepoRemoteUrl={createRepoRemoteUrl}
                    onCreateRepoRemoteUrlChange={setCreateRepoRemoteUrl}
                    createRepoIdentity={createRepoIdentity}
                    onCreateRepoIdentityChange={setCreateRepoIdentity}
                    createManualOpen={createManualOpen}
                    onCreateManualOpenChange={setCreateManualOpen}
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
            </div>

            <div className="flex items-center gap-2">
                <div className="ml-auto flex items-center gap-2">
                    <button
                        type="button"
                        className={meshReady ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                        onClick={onClose}
                    >
                        {meshReady ? t('setupWizard.continueToMesh') : t('setupWizard.close')}
                    </button>
                </div>
            </div>
        </div>
    )
}
