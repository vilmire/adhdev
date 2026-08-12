/**
 * useMeshNodeActions — node CRUD, policy, provider priority, system prompts,
 * coordinator prompt, and coordinator launch state/actions.
 */
import { useState, useMemo, useEffect } from 'react'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import {
    normalizeAvailableCliProviders,
    normalizeProviderPriority,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import type { RepoMeshContextValue, RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshEntry, MeshNode, NodeCapabilitySlot } from './types'
import { readMeshPolicy } from './types'

interface UseMeshNodeActionsOptions {
    selectedMesh: MeshEntry | null
    selectedMeshId: string | null
    primaryDaemonId: string
    activeDaemonId: string
    daemons: RepoMeshDaemonEntry[]
    availableCliProviders: AvailableCliProviderOption[]
    sendCommand: RepoMeshContextValue['sendCommand']
    unwrapResult: RepoMeshContextValue['unwrapResult']
    loadLiveMesh?: RepoMeshContextValue['loadLiveMesh']
    resolveCommandTarget: RepoMeshContextValue['resolveCommandTarget']
    launchCoordinator: RepoMeshContextValue['launchCoordinator']
    features: {
        addNodeDaemonPicker: boolean
    }
    loadMeshes: () => Promise<void>
    loadQueue: (meshId: string | null) => Promise<void>
    queueSection: boolean
    setError: (msg: string | null) => void
}

export function useMeshNodeActions({
    selectedMesh,
    selectedMeshId,
    primaryDaemonId,
    activeDaemonId,
    daemons,
    sendCommand,
    unwrapResult,
    loadLiveMesh,
    resolveCommandTarget,
    launchCoordinator,
    features,
    loadMeshes,
    loadQueue,
    queueSection,
    setError,
}: UseMeshNodeActionsOptions) {
    // Selected node in the node list
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')
    const [nodeProviderPriority, setNodeProviderPriority] = useState<string[]>([])

    // Cloud add-node extras
    const [nodeDaemonId, setNodeDaemonId] = useState('')
    const [nodeCustomPath, setNodeCustomPath] = useState(false)
    const [nodeOnboardingPlan, setNodeOnboardingPlan] = useState<any>(null)
    const [nodePlanLoading, setNodePlanLoading] = useState(false)

    // Coordinator (cloud) — coordinatorDaemonId is owned by RepoMesh.tsx, passed via activeDaemonId
    const [coordinatorCliType, setCoordinatorCliType] = useState('')
    const [launchingCoordinator, setLaunchingCoordinator] = useState(false)
    const [settingMeshHost, setSettingMeshHost] = useState(false)
    const [launchResult, setLaunchResult] = useState<string | null>(null)

    // Policy save
    const [savingPolicy, setSavingPolicy] = useState(false)

    // Coordinator prompt
    const [coordinatorPromptDraft, setCoordinatorPromptDraft] = useState({ override: '', append: '' })
    const [savingCoordinatorPrompt, setSavingCoordinatorPrompt] = useState(false)

    // Per-node system prompt drafts
    const [nodeSystemPromptDrafts, setNodeSystemPromptDrafts] = useState<Record<string, string>>({})
    const [savingNodeSystemPromptId, setSavingNodeSystemPromptId] = useState<string | null>(null)

    // Derived: selected node's daemon picker workspaces + providers
    const selectedNodeDaemon = useMemo(
        () => daemons.find(d => d.id === nodeDaemonId),
        [daemons, nodeDaemonId],
    )
    const nodePickerWorkspaces = selectedNodeDaemon?.workspaces || []
    const nodePickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedNodeDaemon as any)?.availableProviders || []),
        [selectedNodeDaemon],
    )

    // Probe the workspace on the daemon that owns it. Pass the selected mesh as
    // read-only inline inventory so a not-yet-attached remote daemon can still
    // validate repository identity against the host's mesh.
    useEffect(() => {
        if (!showAddNode || !selectedMeshId || !nodeWorkspace.trim()) {
            setNodeOnboardingPlan(null)
            return
        }
        const planDaemonId = features.addNodeDaemonPicker ? nodeDaemonId : ((selectedMesh as any)?.__sourceDaemonId || primaryDaemonId)
        if (!planDaemonId) return
        let cancelled = false
        setNodePlanLoading(true)
        void sendCommand(planDaemonId, 'plan_mesh_onboarding', {
            workspace: nodeWorkspace.trim(),
            meshId: selectedMeshId,
            inlineMesh: selectedMesh,
            operation: 'add_existing',
        }).then(raw => {
            if (!cancelled) setNodeOnboardingPlan(unwrapResult(raw))
        }).catch(error => {
            if (!cancelled) setNodeOnboardingPlan({ success: false, error: error?.message || 'Git discovery failed' })
        }).finally(() => {
            if (!cancelled) setNodePlanLoading(false)
        })
        return () => { cancelled = true }
    }, [
        showAddNode,
        selectedMeshId,
        selectedMesh,
        nodeWorkspace,
        nodeDaemonId,
        primaryDaemonId,
        features.addNodeDaemonPicker,
        sendCommand,
        unwrapResult,
    ])

    // ─── Actions ──────────────────────────────────────────────────

    async function handleAddNode() {
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        if (!selectedMeshId || !targetDaemonId) return
        const ws = nodeWorkspace.trim()
        if (!ws) return
        try {
            const planDaemonId = features.addNodeDaemonPicker ? nodeDaemonId : targetDaemonId
            const planRaw = await sendCommand(planDaemonId, 'plan_mesh_onboarding', {
                workspace: ws,
                meshId: selectedMeshId,
                inlineMesh: selectedMesh,
                operation: 'add_existing',
            })
            const plan = unwrapResult(planRaw)
            setNodeOnboardingPlan(plan)
            if (plan?.success === false) {
                throw new Error(`${plan.code || 'onboarding_blocked'}: ${plan.error}${plan.action ? ` ${plan.action}` : ''}`)
            }
            const payload: any = {
                meshId: selectedMeshId,
                workspace: plan?.discovery?.repoRoot || ws,
                repoRoot: plan?.discovery?.repoRoot,
                isLocalWorktree: plan?.discovery?.isLinkedWorktree === true,
            }
            // Persist the full chosen order (dedup only) — don't strip providers
            // not detected right now; the daemon skips undetected providers at launch.
            if (features.addNodeDaemonPicker && nodeDaemonId) {
                payload.daemonId = nodeDaemonId
                payload.machineId = selectedNodeDaemon?.machineId
            }
            payload.providerPriority = normalizeProviderPriority(nodeProviderPriority)
            const raw = await sendCommand(targetDaemonId, 'add_mesh_node', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Add node failed')
            setShowAddNode(false)
            setNodeWorkspace('')
            setNodeProviderPriority([])
            setNodeDaemonId('')
            setNodeCustomPath(false)
            await loadMeshes()
            if (!queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Add node failed') }
    }

    async function handleRemoveNode(nodeId: string) {
        if (!selectedMesh) return
        const policy = readMeshPolicy(selectedMesh)
        const cleanupLabel = (
            [
                { value: 'preserve', label: 'Preserve history and runtimes' },
                { value: 'stop', label: 'Stop live runtimes only' },
                { value: 'delete_stopped', label: 'Delete stopped sessions only' },
                { value: 'stop_and_delete', label: 'Stop and delete sessions' },
            ] as const
        ).find(o => o.value === policy.sessionCleanupOnNodeRemove)?.label || 'Preserve history and runtimes'
        if (!confirm(`Remove this node?\n\nNode removal cleanup policy: ${cleanupLabel}`)) return
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'remove_mesh_node', { meshId: selectedMesh.id, nodeId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Remove failed')
            if (selectedNodeId === nodeId) setSelectedNodeId(null)
            await loadMeshes()
            if (!queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Remove node failed') }
    }

    async function handleUpdatePolicy(patch: Record<string, unknown>) {
        if (!selectedMesh) return
        const nextPolicy = { ...readMeshPolicy(selectedMesh), ...patch }
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            setSavingPolicy(true)
            setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh', { meshId: selectedMesh.id, policy: nextPolicy })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Policy update failed')
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Policy update failed') }
        finally { setSavingPolicy(false) }
    }

    // Per-node scheduling settings (priority / provider roles). Saved as a minimal
    // policy patch — updateNode shallow-merges into the existing node policy, so
    // this never clobbers providerPriority/systemPrompt or vice versa.
    // Per-node capability slots (ORCHESTRATION_NODE_SLOTS.md). Saved as a minimal
    // policy patch — update_mesh_node shallow-merges the policy, so sending only
    // `{ slots }` replaces the slots array without clobbering sibling policy fields.
    // An explicit empty array clears the slots (node falls back to legacy routing).
    const [savingNodeSlotsId, setSavingNodeSlotsId] = useState<string | null>(null)
    async function handleUpdateNodeSlots(node: MeshNode, slots: NodeCapabilitySlot[]) {
        if (!selectedMeshId) return
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        try {
            setSavingNodeSlotsId(node.id)
            setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh_node', {
                meshId: selectedMeshId,
                nodeId: node.id,
                policy: { slots },
            })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node slots update failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node slots update failed') }
        finally { setSavingNodeSlotsId(null) }
    }

    // Per-node custom capability tags (routing tags). Sent as a top-level
    // `capabilities` arg so update_mesh_node normalizes it; an explicit
    // (possibly empty) array replaces the node's custom tags.
    const [savingNodeCapabilitiesId, setSavingNodeCapabilitiesId] = useState<string | null>(null)
    async function handleUpdateNodeCapabilities(node: MeshNode, capabilities: string[]) {
        if (!selectedMeshId) return
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        const cleaned = capabilities.map(t => t.trim()).filter(Boolean)
        try {
            setSavingNodeCapabilitiesId(node.id)
            setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, capabilities: cleaned })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node tag update failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node tag update failed') }
        finally { setSavingNodeCapabilitiesId(null) }
    }

    async function handleSaveCoordinatorPrompt() {
        if (!primaryDaemonId || !selectedMeshId) return
        const existingCoord = ((selectedMesh as any)?.coordinator || {}) as Record<string, unknown>
        const nextCoord: Record<string, unknown> = { ...existingCoord }
        if (coordinatorPromptDraft.override.trim()) nextCoord.systemPromptOverride = coordinatorPromptDraft.override
        else delete nextCoord.systemPromptOverride
        if (coordinatorPromptDraft.append.trim()) nextCoord.systemPromptAppend = coordinatorPromptDraft.append
        else delete nextCoord.systemPromptAppend
        delete nextCoord.systemPromptSuffix
        try {
            setSavingCoordinatorPrompt(true)
            setError(null)
            const raw = await sendCommand(primaryDaemonId, 'update_mesh', { meshId: selectedMeshId, coordinator: nextCoord })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Coordinator prompt save failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Coordinator prompt save failed') }
        finally { setSavingCoordinatorPrompt(false) }
    }

    async function handleSaveNodeSystemPrompt(node: MeshNode) {
        if (!primaryDaemonId || !selectedMeshId) return
        const next = (nodeSystemPromptDrafts[node.id] || '').trim()
        try {
            setSavingNodeSystemPromptId(node.id)
            setError(null)
            const raw = await sendCommand(primaryDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, systemPrompt: next })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node instruction save failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node instruction save failed') }
        finally { setSavingNodeSystemPromptId(null) }
    }

    /**
     * HOST-PIN-WRITER: persist the operator's first-setup host choice.
     *
     * The host pin is effectively permanent, so establishing it is its own explicit
     * action rather than a side effect of Launch — a mis-click on a launch button must
     * not permanently re-home a mesh. The daemon refuses reassignment of an existing
     * pin (code 'host_already_pinned'), so this is safe to retry and cannot steal a
     * host from another daemon.
     *
     * The command goes to the daemon being made host: it owns the meshes.json that
     * holds the pin, and it is the daemon that must answer as host afterwards.
     */
    async function handleSetMeshHost(hostDaemonId: string) {
        if (!selectedMesh || !hostDaemonId) return
        setError(null)
        setLaunchResult(null)
        try {
            setSettingMeshHost(true)
            const hostNode = (selectedMesh.nodes || []).find(n =>
                daemonIdsEquivalent(String((n as any).daemon_id || (n as any).daemonId || ''), hostDaemonId))
            const raw = await sendCommand(hostDaemonId, 'set_mesh_host', {
                meshId: selectedMesh.id,
                hostDaemonId,
                ...(hostNode?.id ? { hostNodeId: hostNode.id } : {}),
            })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Setting the mesh host failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Setting the mesh host failed') }
        finally { setSettingMeshHost(false) }
    }

    async function handleLaunchCoordinator() {
        if (!selectedMesh) return
        setError(null)
        setLaunchResult(null)
        try {
            setLaunchingCoordinator(true)
            const liveMesh = loadLiveMesh ? await loadLiveMesh(activeDaemonId, selectedMesh.id, selectedMesh) : null
            const target = resolveCommandTarget(activeDaemonId, selectedMesh.id, selectedMesh, selectedMesh.nodes || [], liveMesh)
            if ('error' in target) throw new Error(target.error)
            const result = await launchCoordinator(target.targetDaemonId, {
                meshId: selectedMesh.id,
                inlineMesh: target.inlineMesh,
                coordinatorNodeId: target.coordinatorNodeId,
                cliType: coordinatorCliType.trim() || undefined,
            })
            setLaunchResult(result.message)
        } catch (e: any) { setError(e?.message || 'Coordinator launch failed') }
        finally { setLaunchingCoordinator(false) }
    }

    return {
        // selected node
        selectedNodeId,
        setSelectedNodeId,
        // add node form
        showAddNode,
        setShowAddNode,
        nodeWorkspace,
        setNodeWorkspace,
        nodeProviderPriority,
        setNodeProviderPriority,
        nodeDaemonId,
        setNodeDaemonId,
        nodeCustomPath,
        setNodeCustomPath,
        nodePickerWorkspaces,
        nodePickerProviders,
        nodeOnboardingPlan,
        nodePlanLoading,
        // coordinator
        coordinatorCliType,
        setCoordinatorCliType,
        launchingCoordinator,
        launchResult,
        // host pin (first-setup)
        settingMeshHost,
        // policy
        savingPolicy,
        // coordinator prompt
        coordinatorPromptDraft,
        setCoordinatorPromptDraft,
        savingCoordinatorPrompt,
        // node system prompts
        nodeSystemPromptDrafts,
        setNodeSystemPromptDrafts,
        savingNodeSystemPromptId,
        // node capability slots
        savingNodeSlotsId,
        // node capability tags
        savingNodeCapabilitiesId,
        // actions
        handleAddNode,
        handleRemoveNode,
        handleUpdatePolicy,
        handleUpdateNodeSlots,
        handleUpdateNodeCapabilities,
        handleSaveCoordinatorPrompt,
        handleSaveNodeSystemPrompt,
        handleLaunchCoordinator,
        handleSetMeshHost,
    }
}
