/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'

import AppPage from '../components/ui/AppPage'
import { IconMesh } from '../components/Icons'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    normalizeProviderPriority,
    normalizeProviderPriorityForInventory,
    type AvailableCliProviderOption,
} from '../utils/provider-priority'
import { useMeshGraphMetadataSubscription } from '../hooks/useMeshGraphMetadataSubscription'
import {
    useRepoMeshContext,
    type RepoMeshDaemonEntry,
} from '../context/RepoMeshContext'
import { MeshListView } from './repo-mesh/MeshListView'
import { MeshDetailView } from './repo-mesh/MeshDetailView'
import type {
    MeshNode,
    MeshEntry,
    MeshQueueEntry,
    MeshQueueSummary,
    AvailableCliAgent,
    ProviderPriorityDrafts,
} from './repo-mesh/types'

// Re-export types that cloud/standalone wrappers may reference
export type { MeshNode, MeshQueueEntry, AvailableCliAgent }
export { RepoMeshHermesMcpConfig } from './repo-mesh/MeshHermesMcpConfig'
export { getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from './repo-mesh/MeshNodeList'

// ─── Helpers ─────────────────────────────────────────────────────

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

function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return {
        requirePreTaskCheckpoint: false,
        requirePostTaskCheckpoint: true,
        requireApprovalForPush: true,
        allowAutoPublishSubmoduleMainCommits: false,
        requireApprovalForDestructiveGit: true,
        dirtyWorkspaceBehavior: 'warn',
        maxParallelTasks: 2,
        sessionCleanupOnNodeRemove: 'preserve',
        ...(mesh?.policy || {}),
    }
}

function buildQueueSummary(queue: MeshQueueEntry[]): MeshQueueSummary {
    const active = queue.filter(t => t.status === 'pending' || t.status === 'assigned')
    const historical = queue.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    return {
        active: active.length,
        historical: historical.length,
        activeCounts: { pending: active.filter(t => t.status === 'pending').length, assigned: active.filter(t => t.status === 'assigned').length },
        historicalCounts: { completed: historical.filter(t => t.status === 'completed').length, failed: historical.filter(t => t.status === 'failed').length },
        counts: {
            pending: queue.filter(t => t.status === 'pending').length,
            assigned: queue.filter(t => t.status === 'assigned').length,
            completed: queue.filter(t => t.status === 'completed').length,
            failed: queue.filter(t => t.status === 'failed').length,
        },
        staleAssignedCount: queue.filter(t => t.staleAssigned).length,
        recent: queue.slice(0, 20),
    }
}

// ─── Main page ───────────────────────────────────────────────────

export default function RepoMesh() {
    const ctx = useRepoMeshContext()
    const { sendCommand, sendData, daemons, userName, loadMeshStatus, launchCoordinator,
        loadLiveMesh, extractStatus, unwrapResult, normalizeMesh,
        resolveCommandTarget, features } = ctx

    // Standalone: first daemon; cloud: selected coordinator daemon
    const primaryDaemon = daemons[0] as RepoMeshDaemonEntry | undefined
    const primaryDaemonId = primaryDaemon?.id || ''

    // Extract available CLI agents + providers from the primary daemon
    const availableCliAgents: AvailableCliAgent[] = useMemo(() => {
        const providers = (primaryDaemon as any)?.availableProviders || []
        return providers
            .filter((p: any) => p.category === 'cli')
            .map((p: any) => ({ id: p.type || p.id, name: p.displayName || p.name || p.type, meshCoordinator: p.meshCoordinator }))
    }, [primaryDaemon])

    const availableCliProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((primaryDaemon as any)?.availableProviders || []),
        [primaryDaemon],
    )

    // ─── State ───

    const [meshes, setMeshes] = useState<MeshEntry[]>([])
    const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [savingPolicy, setSavingPolicy] = useState(false)
    const [savingNodePolicyId, setSavingNodePolicyId] = useState<string | null>(null)
    const [nodeProviderPriorityDrafts, setNodeProviderPriorityDrafts] = useState<ProviderPriorityDrafts>({})
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    // Graph
    const [meshGraphStatus, setMeshGraphStatus] = useState<RepoMeshStatus | null>(null)
    const [graphLoading, setGraphLoading] = useState(false)
    const [graphError, setGraphError] = useState<string | null>(null)
    const [graphProvenance, setGraphProvenance] = useState<'idle' | 'first_paint' | 'settling' | 'settled'>('idle')

    // Queue (shared state; only rendered when features.queueSection)
    const [meshQueue, setMeshQueue] = useState<MeshQueueEntry[]>([])
    const [queueSummary, setQueueSummary] = useState<MeshQueueSummary | null>(null)
    const [queueLoading, setQueueLoading] = useState(false)
    const [queueError, setQueueError] = useState<string | null>(null)

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')
    const [createRepoRemoteUrl, setCreateRepoRemoteUrl] = useState('')

    // Cloud create extras
    const [newMeshDaemonId, setNewMeshDaemonId] = useState('')
    const [newMeshWorkspace, setNewMeshWorkspace] = useState('')

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')
    const [nodeProviderPriority, setNodeProviderPriority] = useState<string[]>([])

    // Cloud add-node extras
    const [nodeDaemonId, setNodeDaemonId] = useState('')
    const [nodeCustomPath, setNodeCustomPath] = useState(false)

    // Coordinator (cloud)
    const [coordinatorDaemonId, setCoordinatorDaemonId] = useState('')
    const [coordinatorCliType, setCoordinatorCliType] = useState('')
    const [launchingCoordinator, setLaunchingCoordinator] = useState(false)
    const [launchResult, setLaunchResult] = useState<string | null>(null)

    // Coordinator prompt + node instructions
    const [coordinatorPromptDraft, setCoordinatorPromptDraft] = useState({ override: '', append: '' })
    const [savingCoordinatorPrompt, setSavingCoordinatorPrompt] = useState(false)
    const [nodeSystemPromptDrafts, setNodeSystemPromptDrafts] = useState<Record<string, string>>({})
    const [savingNodeSystemPromptId, setSavingNodeSystemPromptId] = useState<string | null>(null)

    // ─── Derived ─────

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

    // coordinator daemon for cloud; primary for standalone
    const activeDaemonId = features.meshHostDaemonSection
        ? (coordinatorDaemonId || primaryDaemonId)
        : primaryDaemonId

    const activeDaemon = useMemo(
        () => daemons.find(d => d.id === activeDaemonId) || primaryDaemon,
        [daemons, activeDaemonId, primaryDaemon],
    )

    // For cloud daemon picker in add-node form
    const selectedNodeDaemon = useMemo(
        () => daemons.find(d => d.id === nodeDaemonId),
        [daemons, nodeDaemonId],
    )
    const nodePickerWorkspaces = selectedNodeDaemon?.workspaces || []
    const nodePickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedNodeDaemon as any)?.availableProviders || []),
        [selectedNodeDaemon],
    )

    // For cloud daemon picker in create-mesh form
    const selectedCreateDaemon = useMemo(
        () => daemons.find(d => d.id === newMeshDaemonId),
        [daemons, newMeshDaemonId],
    )
    const createPickerWorkspaces = selectedCreateDaemon?.workspaces || []
    const createPickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedCreateDaemon as any)?.availableProviders || []),
        [selectedCreateDaemon],
    )

    const attachedDaemonIds = useMemo(
        () => new Set((selectedMesh?.nodes || []).map(n => String(n.daemon_id || n.daemonId || ''))),
        [selectedMesh],
    )
    const attachableDaemons = useMemo(
        () => daemons.filter(d => d.id && !attachedDaemonIds.has(d.id)),
        [daemons, attachedDaemonIds],
    )

    // Cloud: selected host node
    const nodes: MeshNode[] = selectedMesh?.nodes || []
    const selectedHostNode = useMemo(
        () => nodes.find(n => String(n.daemon_id || n.daemonId || '') === coordinatorDaemonId),
        [nodes, coordinatorDaemonId],
    )
    const isHostNodeAttached = features.meshHostDaemonSection ? !!selectedHostNode : true

    // live subscription enrichment
    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshGraphStatus,
        daemonId: activeDaemonId || null,
        meshId: selectedMeshId,
        sendData,
    })

    // ─── Effects ─────

    useEffect(() => {
        setNodeProviderPriorityDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, readNodeProviderPriority(node)]),
        ))
    }, [selectedMesh])

    useEffect(() => {
        const coord = (selectedMesh as any)?.coordinator || {}
        setCoordinatorPromptDraft({
            override: typeof coord.systemPromptOverride === 'string' ? coord.systemPromptOverride : '',
            append: typeof coord.systemPromptAppend === 'string' ? coord.systemPromptAppend
                : typeof coord.systemPromptSuffix === 'string' ? coord.systemPromptSuffix : '',
        })
        setNodeSystemPromptDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, typeof (node as any).systemPrompt === 'string' ? (node as any).systemPrompt : '']),
        ))
    }, [selectedMesh])

    useEffect(() => {
        const defaultPriority = features.addNodeDaemonPicker
            ? defaultProviderPriorityFromInventory(nodePickerProviders)
            : defaultProviderPriorityFromInventory(availableCliProviders)
        if (showAddNode && nodeProviderPriority.length === 0 && defaultPriority.length > 0) {
            setNodeProviderPriority(defaultPriority)
        }
    }, [showAddNode, availableCliProviders, nodePickerProviders, nodeProviderPriority.length, features.addNodeDaemonPicker])

    useEffect(() => {
        const nodeIds = new Set((selectedMesh?.nodes || []).map(n => n.id))
        if (selectedNodeId && !nodeIds.has(selectedNodeId)) setSelectedNodeId(null)
    }, [selectedMesh, selectedNodeId])

    // Cloud: init coordinator daemon id from daemons list
    useEffect(() => {
        if (!features.meshHostDaemonSection) return
        if (!daemons.length) { setCoordinatorDaemonId(''); return }
        if (!coordinatorDaemonId || !daemons.some(d => d.id === coordinatorDaemonId)) {
            setCoordinatorDaemonId(daemons[0].id)
        }
    }, [daemons, coordinatorDaemonId, features.meshHostDaemonSection])

    // Cloud: init newMeshDaemonId
    useEffect(() => {
        if (!features.createDaemonPicker) return
        if (!daemons.length) { setNewMeshDaemonId(''); return }
        if (!newMeshDaemonId || !daemons.some(d => d.id === newMeshDaemonId)) {
            setNewMeshDaemonId(daemons[0].id)
        }
    }, [daemons, newMeshDaemonId, features.createDaemonPicker])

    // Cloud: auto-select first workspace when daemon changes in create form
    useEffect(() => {
        if (!features.createDaemonPicker || !newMeshDaemonId) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.length) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.some(w => w.path === newMeshWorkspace)) {
            setNewMeshWorkspace(createPickerWorkspaces[0]?.path || '')
        }
    }, [newMeshDaemonId, newMeshWorkspace, createPickerWorkspaces, features.createDaemonPicker])

    useEffect(() => {
        if (selectedMeshId) {
            setMeshGraphStatus(null)
            setGraphError(null)
            void loadGraph()
        }
    }, [selectedMeshId, activeDaemonId])

    useEffect(() => {
        if (features.queueSection) return // cloud loads queue on demand
        void loadQueue(selectedMeshId)
    }, [selectedMeshId, features.queueSection])

    // ─── Data loading ────────────────────────────────────────────

    const loadMeshes = useCallback(async () => {
        setLoading(true)
        try {
            if (features.createDaemonPicker) {
                // Cloud: load from all daemons in parallel
                const results = await Promise.allSettled(daemons.map(async daemon => {
                    if (!daemon.id) return []
                    const raw = await sendCommand(daemon.id, 'list_meshes', {})
                    const result = unwrapResult(raw)
                    if (result?.success === false) throw new Error(result.error || 'Failed to load meshes')
                    return (Array.isArray(result?.meshes) ? result.meshes : [])
                        .map((m: any) => normalizeMesh(m, daemon.id))
                        .filter((m: any) => m.id)
                }))
                const byId = new Map<string, MeshEntry>()
                for (const r of results) {
                    if (r.status !== 'fulfilled') continue
                    for (const m of r.value) { if (!byId.has(m.id)) byId.set(m.id, m) }
                }
                setMeshes(Array.from(byId.values()))
            } else {
                // Standalone: single daemon
                if (!primaryDaemonId) return
                const res: any = await sendCommand(primaryDaemonId, 'list_meshes')
                if (res?.success) {
                    setMeshes((res.meshes || []).map((m: any) => normalizeMesh(m, primaryDaemonId)))
                    setError(null)
                } else {
                    setError(res?.error || 'Failed to load meshes')
                }
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to load meshes')
        } finally {
            setLoading(false)
        }
    }, [daemons, primaryDaemonId, sendCommand, unwrapResult, normalizeMesh, features.createDaemonPicker])

    const loadQueue = useCallback(async (meshId: string | null) => {
        if (!primaryDaemonId || !meshId) { setMeshQueue([]); return }
        try {
            const res: any = await sendCommand(primaryDaemonId, 'get_mesh_queue', { meshId })
            setMeshQueue(res?.success ? (Array.isArray(res.queue) ? res.queue : []) : [])
        } catch { setMeshQueue([]) }
    }, [primaryDaemonId, sendCommand])

    async function loadGraph(refresh = false) {
        if (!activeDaemonId || !selectedMeshId) return
        try {
            setGraphLoading(!refresh && meshGraphStatus === null)
            setGraphProvenance(refresh ? 'settling' : 'first_paint')
            setGraphError(null)
            const response = await loadMeshStatus(activeDaemonId, selectedMeshId, {
                refresh,
                retryProfile: refresh ? 'settled' : 'interactive',
            })
            const status = extractStatus(response)
            if (status) {
                setMeshGraphStatus(status)
                setGraphProvenance('settled')
            } else {
                setMeshGraphStatus(null)
                setGraphError('mesh_status returned an unexpected payload.')
                setGraphProvenance('idle')
            }
        } catch (e: any) {
            if (!meshGraphStatus) setMeshGraphStatus(null)
            setGraphError(e?.message || 'Failed to load mesh graph')
            setGraphProvenance('idle')
        } finally {
            setGraphLoading(false)
        }
    }

    async function handleLoadQueue() {
        if (!selectedMesh) return
        setQueueLoading(true)
        setQueueError(null)
        try {
            const liveMesh = loadLiveMesh
                ? await loadLiveMesh(activeDaemonId, selectedMesh.id, selectedMesh)
                : null
            const target = resolveCommandTarget(activeDaemonId, selectedMesh.id, selectedMesh, selectedMesh.nodes || [], liveMesh)
            if ('error' in target) throw new Error(target.error)
            const raw = await sendCommand(target.targetDaemonId, 'get_mesh_queue', { meshId: selectedMesh.id })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Queue load failed')
            const queue: MeshQueueEntry[] = Array.isArray(result?.result?.rows ?? result?.rows ?? result?.queue)
                ? (result?.result?.rows ?? result?.rows ?? result?.queue)
                : []
            setQueueSummary(buildQueueSummary(queue))
        } catch (e: any) {
            setQueueError(e?.message || 'Queue load failed')
        } finally {
            setQueueLoading(false)
        }
    }

    useEffect(() => { void loadMeshes() }, [loadMeshes])

    // ─── Actions ─────────────────────────────────────────────────

    async function handleCreate() {
        const targetDaemonId = features.createDaemonPicker ? newMeshDaemonId : primaryDaemonId
        if (!targetDaemonId || !createName.trim()) return
        const remoteUrl = createRepoRemoteUrl.trim()
        const identity = createRepoIdentity.trim()
        if (!remoteUrl && !identity) return
        try {
            const payload: any = { name: createName.trim() }
            if (remoteUrl) payload.repoRemoteUrl = remoteUrl
            if (identity) payload.repoIdentity = identity
            const raw = await sendCommand(targetDaemonId, 'create_mesh', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Create failed')
            const meshId = typeof result?.mesh?.id === 'string' ? result.mesh.id : ''
            if (meshId && features.createDaemonPicker && newMeshWorkspace) {
                const addRaw = await sendCommand(targetDaemonId, 'add_mesh_node', {
                    meshId,
                    daemonId: targetDaemonId,
                    machineId: selectedCreateDaemon?.machineId,
                    workspace: newMeshWorkspace,
                    role: 'host',
                    providerPriority: defaultProviderPriorityFromInventory(createPickerProviders),
                })
                const addResult = unwrapResult(addRaw)
                if (addResult?.success === false) throw new Error(addResult.error || 'Mesh created but failed to attach workspace')
            }
            setShowCreate(false); setCreateName(''); setCreateRepoIdentity(''); setCreateRepoRemoteUrl(''); setNewMeshWorkspace('')
            await loadMeshes()
            if (result?.mesh?.id) setSelectedMeshId(result.mesh.id)
        } catch (e: any) { setError(e?.message || 'Create failed') }
    }

    async function handleDelete(meshId: string) {
        if (!confirm('Delete this mesh? This cannot be undone.')) return
        const targetDaemonId = (meshes.find(m => m.id === meshId) as any)?.__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'delete_mesh', { meshId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to delete')
            if (selectedMeshId === meshId) { setSelectedMeshId(null); setMeshGraphStatus(null) }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Delete failed') }
    }

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
            setShowAddNode(false); setNodeWorkspace(''); setNodeProviderPriority([]); setNodeDaemonId(''); setNodeCustomPath(false)
            await loadMeshes()
            if (!features.queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Add node failed') }
    }

    async function handleRemoveNode(nodeId: string) {
        if (!selectedMesh) return
        const policy = readMeshPolicy(selectedMesh)
        const SESSION_CLEANUP_MODE_OPTIONS = [
            { value: 'preserve', label: 'Preserve history and runtimes' },
            { value: 'stop', label: 'Stop live runtimes only' },
            { value: 'delete_stopped', label: 'Delete stopped sessions only' },
            { value: 'stop_and_delete', label: 'Stop and delete sessions' },
        ]
        const cleanupLabel = SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove)?.label || 'Preserve history and runtimes'
        if (!confirm(`Remove this node?\n\nNode removal cleanup policy: ${cleanupLabel}`)) return
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'remove_mesh_node', { meshId: selectedMesh.id, nodeId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Remove failed')
            if (selectedNodeId === nodeId) setSelectedNodeId(null)
            await loadMeshes()
            if (!features.queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Remove node failed') }
    }

    async function handleUpdatePolicy(patch: Record<string, unknown>) {
        if (!selectedMesh) return
        const nextPolicy = { ...readMeshPolicy(selectedMesh), ...patch }
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            setSavingPolicy(true); setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh', { meshId: selectedMesh.id, policy: nextPolicy })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Policy update failed')
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Policy update failed') }
        finally { setSavingPolicy(false) }
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
            setSavingCoordinatorPrompt(true); setError(null)
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
            setSavingNodeSystemPromptId(node.id); setError(null)
            const raw = await sendCommand(primaryDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, systemPrompt: next })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node instruction save failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node instruction save failed') }
        finally { setSavingNodeSystemPromptId(null) }
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
            setSavingNodePolicyId(node.id); setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, policy: nextPolicy, providerPriority })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node policy update failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node policy update failed') }
        finally { setSavingNodePolicyId(null) }
    }

    async function handleLaunchCoordinator() {
        if (!selectedMesh) return
        setError(null); setLaunchResult(null)
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

    // ─── Render ───────────────────────────────────────────────────

    if (!primaryDaemonId) {
        return (
            <AppPage icon={<IconMesh />} title="Repo Mesh" subtitle="Multi-workspace orchestration">
                <div className="text-sm text-text-muted p-4">Waiting for daemon connection...</div>
            </AppPage>
        )
    }

    if (!selectedMesh) {
        return (
            <MeshListView
                meshes={meshes}
                loading={loading}
                error={error}
                onDismissError={() => setError(null)}
                daemons={daemons}
                features={{ createDaemonPicker: features.createDaemonPicker }}
                showCreate={showCreate}
                onToggleCreate={() => setShowCreate(!showCreate)}
                createName={createName}
                onCreateNameChange={setCreateName}
                createRepoIdentity={createRepoIdentity}
                onCreateRepoIdentityChange={setCreateRepoIdentity}
                createRepoRemoteUrl={createRepoRemoteUrl}
                onCreateRepoRemoteUrlChange={setCreateRepoRemoteUrl}
                newMeshDaemonId={newMeshDaemonId}
                onNewMeshDaemonIdChange={setNewMeshDaemonId}
                newMeshWorkspace={newMeshWorkspace}
                onNewMeshWorkspaceChange={setNewMeshWorkspace}
                createPickerWorkspaces={createPickerWorkspaces}
                onSelectMesh={setSelectedMeshId}
                onCreate={handleCreate}
                onCancelCreate={() => { setShowCreate(false); setCreateName(''); setCreateRepoIdentity(''); setCreateRepoRemoteUrl('') }}
            />
        )
    }

    return (
        <MeshDetailView
            selectedMesh={selectedMesh}
            error={error}
            onDismissError={() => setError(null)}
            onBack={() => { setSelectedMeshId(null); setMeshGraphStatus(null) }}
            onDelete={handleDelete}
            displayedMeshStatus={displayedMeshStatus}
            graphLoading={graphLoading}
            graphError={graphError}
            graphProvenance={graphProvenance}
            onRefreshGraph={loadGraph}
            queueSummary={queueSummary}
            queueLoading={queueLoading}
            queueError={queueError}
            onLoadQueue={handleLoadQueue}
            savingPolicy={savingPolicy}
            onUpdatePolicy={handleUpdatePolicy}
            coordinatorPromptDraft={coordinatorPromptDraft}
            onCoordinatorPromptDraftChange={setCoordinatorPromptDraft}
            savingCoordinatorPrompt={savingCoordinatorPrompt}
            onSaveCoordinatorPrompt={handleSaveCoordinatorPrompt}
            daemons={daemons}
            coordinatorDaemonId={coordinatorDaemonId}
            onCoordinatorDaemonIdChange={id => { setCoordinatorDaemonId(id); setMeshGraphStatus(null) }}
            coordinatorCliType={coordinatorCliType}
            onCoordinatorCliTypeChange={setCoordinatorCliType}
            launchingCoordinator={launchingCoordinator}
            launchResult={launchResult}
            attachedDaemonIds={attachedDaemonIds}
            isHostNodeAttached={isHostNodeAttached}
            selectedHostNode={selectedHostNode}
            onLaunchCoordinator={handleLaunchCoordinator}
            activeDaemon={activeDaemon}
            activeDaemonId={activeDaemonId}
            meshQueue={meshQueue}
            userName={userName}
            nodeProviderPriorityDrafts={nodeProviderPriorityDrafts}
            onNodeProviderPriorityDraftChange={(nodeId, next) => setNodeProviderPriorityDrafts(prev => ({ ...prev, [nodeId]: next }))}
            availableCliProviders={availableCliProviders}
            savingNodePolicyId={savingNodePolicyId}
            onUpdateNodeProviderPriority={handleUpdateNodeProviderPriority}
            nodeSystemPromptDrafts={nodeSystemPromptDrafts}
            onNodeSystemPromptDraftChange={(nodeId, value) => setNodeSystemPromptDrafts(prev => ({ ...prev, [nodeId]: value }))}
            savingNodeSystemPromptId={savingNodeSystemPromptId}
            onSaveNodeSystemPrompt={handleSaveNodeSystemPrompt}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            showAddNode={showAddNode}
            onShowAddNode={() => setShowAddNode(true)}
            onCancelAddNode={() => setShowAddNode(false)}
            nodeWorkspace={nodeWorkspace}
            onNodeWorkspaceChange={setNodeWorkspace}
            nodeProviderPriority={nodeProviderPriority}
            onNodeProviderPriorityChange={setNodeProviderPriority}
            nodeDaemonId={nodeDaemonId}
            onNodeDaemonIdChange={setNodeDaemonId}
            nodeCustomPath={nodeCustomPath}
            onNodeCustomPathChange={setNodeCustomPath}
            nodePickerWorkspaces={nodePickerWorkspaces}
            nodePickerProviders={nodePickerProviders}
            attachableDaemons={attachableDaemons}
            onAddNode={handleAddNode}
            onRemoveNode={handleRemoveNode}
            availableCliAgents={availableCliAgents}
            features={{
                coordinatorPrompt: features.coordinatorPrompt,
                meshHostDaemonSection: features.meshHostDaemonSection,
                queueSection: features.queueSection,
                hermesMcpConfig: features.hermesMcpConfig,
                addNodeDaemonPicker: features.addNodeDaemonPicker,
                nodeInstruction: features.nodeInstruction,
            }}
            sendCommand={sendCommand}
        />
    )
}
