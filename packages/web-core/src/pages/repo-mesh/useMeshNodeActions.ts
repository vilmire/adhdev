/**
 * useMeshNodeActions — node CRUD, policy, provider priority, system prompts,
 * coordinator prompt, and coordinator launch state/actions.
 */
import { useState, useMemo } from 'react'
import {
    normalizeAvailableCliProviders,
    normalizeProviderPriority,
    normalizeProviderPriorityForInventory,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import type { RepoMeshContextValue, RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshEntry, MeshNode, ProviderPriorityDrafts } from './types'
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
    availableCliProviders,
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
    // Per-node provider priority drafts
    const [nodeProviderPriorityDrafts, setNodeProviderPriorityDrafts] = useState<ProviderPriorityDrafts>({})
    const [savingNodePolicyId, setSavingNodePolicyId] = useState<string | null>(null)

    // Selected node in the node list
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')
    const [nodeProviderPriority, setNodeProviderPriority] = useState<string[]>([])

    // Cloud add-node extras
    const [nodeDaemonId, setNodeDaemonId] = useState('')
    const [nodeCustomPath, setNodeCustomPath] = useState(false)

    // Coordinator (cloud) — coordinatorDaemonId is owned by RepoMesh.tsx, passed via activeDaemonId
    const [coordinatorCliType, setCoordinatorCliType] = useState('')
    const [launchingCoordinator, setLaunchingCoordinator] = useState(false)
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

    // ─── Actions ──────────────────────────────────────────────────

    async function handleAddNode() {
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        if (!selectedMeshId || !targetDaemonId) return
        const ws = nodeWorkspace.trim()
        if (!ws) return
        try {
            const payload: any = { meshId: selectedMeshId, workspace: ws }
            if (features.addNodeDaemonPicker && nodeDaemonId) {
                payload.daemonId = nodeDaemonId
                payload.machineId = selectedNodeDaemon?.machineId
                payload.providerPriority = normalizeProviderPriorityForInventory(nodeProviderPriority, nodePickerProviders)
            } else {
                payload.providerPriority = normalizeProviderPriorityForInventory(nodeProviderPriority, availableCliProviders)
            }
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

    async function handleUpdateNodeProviderPriority(node: MeshNode) {
        if (!selectedMeshId) return
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        const providers = features.addNodeDaemonPicker ? nodePickerProviders : availableCliProviders
        const requested = nodeProviderPriorityDrafts[node.id] || readNodeProviderPriority(node)
        const providerPriority = providers.length > 0
            ? normalizeProviderPriorityForInventory(requested, providers)
            : normalizeProviderPriority(requested)
        const nextPolicy = { ...(node.policy || {}) }
        delete (nextPolicy as any).provider_priority
        if (providerPriority.length) nextPolicy.providerPriority = providerPriority
        else delete nextPolicy.providerPriority
        try {
            setSavingNodePolicyId(node.id)
            setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, policy: nextPolicy, providerPriority })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node policy update failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node policy update failed') }
        finally { setSavingNodePolicyId(null) }
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
        // per-node provider priority drafts
        nodeProviderPriorityDrafts,
        setNodeProviderPriorityDrafts,
        savingNodePolicyId,
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
        // coordinator
        coordinatorCliType,
        setCoordinatorCliType,
        launchingCoordinator,
        launchResult,
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
        // actions
        handleAddNode,
        handleRemoveNode,
        handleUpdatePolicy,
        handleUpdateNodeProviderPriority,
        handleSaveCoordinatorPrompt,
        handleSaveNodeSystemPrompt,
        handleLaunchCoordinator,
    }
}

// ─── Helper (also used internally) ──────────────────────────────

function readNodeProviderPriority(node: MeshNode): string[] {
    const raw = Array.isArray(node.providerPriority)
        ? node.providerPriority
        : Array.isArray(node.policy?.providerPriority)
            ? node.policy.providerPriority
            : []
    const seen = new Set<string>()
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => { if (seen.has(type)) return false; seen.add(type); return true })
}
