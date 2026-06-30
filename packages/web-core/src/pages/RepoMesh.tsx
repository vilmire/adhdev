/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'

import AppPage from '../components/ui/AppPage'
import { IconMesh } from '../components/Icons'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../utils/provider-priority'
import { useMeshGraphMetadataSubscription } from '../hooks/useMeshGraphMetadataSubscription'
import {
    useRepoMeshContext,
    type RepoMeshDaemonEntry,
} from '../context/RepoMeshContext'
import { MeshListView } from './repo-mesh/MeshListView'
import { MeshDetailView } from './repo-mesh/MeshDetailView'
import { useMeshList } from './repo-mesh/useMeshList'
import { useMeshNodeActions } from './repo-mesh/useMeshNodeActions'
import { useMeshQueue } from './repo-mesh/useMeshQueue'
import { useMeshGraph } from './repo-mesh/useMeshGraph'
import type { MeshNode, MeshQueueEntry, AvailableCliAgent } from './repo-mesh/types'
import { readMeshPolicy } from './repo-mesh/types'

// Re-export types that cloud/standalone wrappers may reference
export type { MeshNode, MeshQueueEntry, AvailableCliAgent }
export { RepoMeshHermesMcpConfig } from './repo-mesh/MeshHermesMcpConfig'
export { getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from './repo-mesh/MeshNodeList'

// Interval for the visibility-gated automatic graph revalidation. Node
// git/topology/health is pull-only (no server push), so without this the graph
// stays stale until a manual Refresh. Kept conservative: revalidation triggers
// a git probe that is heavy on win32, and we never want to pile reloads onto a
// coordinator's own in-flight refresh. Polling only runs while the tab is
// visible and the detail view is open.
const GRAPH_AUTO_REVALIDATE_INTERVAL_MS = 7000

// ─── Main page ───────────────────────────────────────────────────

export default function RepoMesh() {
    const ctx = useRepoMeshContext()
    const {
        sendCommand, sendData, daemons, userName,
        loadMeshStatus, launchCoordinator, loadLiveMesh,
        extractStatus, unwrapResult, normalizeMesh, normalizeNode,
        resolveCommandTarget, features,
        gateIncompleteGraph,
    } = ctx

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

    // ─── Mesh list ───

    const {
        meshes, selectedMeshId, setSelectedMeshId,
        loading, error, setError,
        showCreate, setShowCreate,
        createName, setCreateName,
        createRepoIdentity, setCreateRepoIdentity,
        createRepoRemoteUrl, setCreateRepoRemoteUrl,
        newMeshDaemonId, setNewMeshDaemonId,
        newMeshWorkspace, setNewMeshWorkspace,
        createPickerWorkspaces,
        loadMeshes, handleCreate, handleDelete, cancelCreate,
    } = useMeshList({
        daemons,
        primaryDaemonId,
        sendCommand,
        unwrapResult,
        normalizeMesh,
        features,
    })

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

    // ─── Graph ───

    const {
        meshGraphStatus, setMeshGraphStatus,
        graphLoading, graphError, setGraphError,
        loadGraph,
    } = useMeshGraph({ selectedMeshId, loadMeshStatus, extractStatus, normalizeNode, gateIncompleteGraph })

    // ─── Coordinator daemon (cloud) ───
    // The host is a fixed 1:1 pin per mesh — there is no UI picker for it. This
    // state is the resolved command/view-source target, derived (not user-chosen):
    // the persisted host normally, or a temporary re-bind override when the host
    // daemon is offline so commands still have a connected route. Kept here so it
    // can flow into useMeshNodeActions and useMeshQueue.
    const [coordinatorDaemonId, setCoordinatorDaemonId] = useState('')

    // Temporary command-routing override used ONLY while the pinned host daemon is
    // offline. This is NOT a host re-assignment — it just picks a connected daemon
    // to command over P2P until the host reconnects. Cleared once the host is back.
    const [hostRebindDaemonId, setHostRebindDaemonId] = useState('')

    const resolvedActiveDaemonId = features.meshHostDaemonSection
        ? (coordinatorDaemonId || primaryDaemonId)
        : primaryDaemonId

    // ─── Queue ───
    // The dedicated Queue settings section was removed (runtime telemetry, not config).
    // meshQueue is still loaded because per-node "active assignments" diagnostics in the
    // node list and the scheduler in useMeshNodeActions consume it; the standalone path
    // auto-loads it below.

    const {
        meshQueue,
        loadQueue,
    } = useMeshQueue({
        primaryDaemonId,
        activeDaemonId: resolvedActiveDaemonId,
        sendCommand,
        unwrapResult,
        loadLiveMesh,
        resolveCommandTarget,
    })

    // ─── Node actions ───

    const {
        nodeProviderPriorityDrafts, setNodeProviderPriorityDrafts,
        savingNodePolicyId,
        selectedNodeId, setSelectedNodeId,
        showAddNode, setShowAddNode,
        nodeWorkspace, setNodeWorkspace,
        nodeProviderPriority, setNodeProviderPriority,
        nodeDaemonId, setNodeDaemonId,
        nodeCustomPath, setNodeCustomPath,
        nodePickerWorkspaces, nodePickerProviders,
        coordinatorCliType, setCoordinatorCliType,
        launchingCoordinator, launchResult,
        savingPolicy,
        coordinatorPromptDraft, setCoordinatorPromptDraft,
        savingCoordinatorPrompt,
        nodeSystemPromptDrafts, setNodeSystemPromptDrafts,
        savingNodeSystemPromptId,
        savingNodeSchedulingId,
        handleAddNode, handleRemoveNode, handleUpdatePolicy,
        handleUpdateNodeProviderPriority,
        handleUpdateNodeScheduling,
        handleSaveCoordinatorPrompt, handleSaveNodeSystemPrompt,
        handleLaunchCoordinator,
    } = useMeshNodeActions({
        selectedMesh,
        selectedMeshId,
        primaryDaemonId,
        activeDaemonId: resolvedActiveDaemonId,
        daemons,
        availableCliProviders,
        sendCommand,
        unwrapResult,
        loadLiveMesh,
        resolveCommandTarget,
        launchCoordinator,
        features: { addNodeDaemonPicker: features.addNodeDaemonPicker },
        loadMeshes,
        loadQueue,
        queueSection: features.queueSection,
        setError,
    })

    // ─── Derived ────────────────────────────────────────────────

    const activeDaemon = useMemo(
        () => daemons.find(d => d.id === resolvedActiveDaemonId) || primaryDaemon,
        [daemons, resolvedActiveDaemonId, primaryDaemon],
    )

    const attachedDaemonIds = useMemo(
        () => new Set((selectedMesh?.nodes || []).map(n => String(n.daemon_id || n.daemonId || ''))),
        [selectedMesh],
    )
    const attachableDaemons = useMemo(
        () => daemons.filter(d => d.id && !attachedDaemonIds.has(d.id)),
        [daemons, attachedDaemonIds],
    )

    const nodes: MeshNode[] = selectedMesh?.nodes || []
    const selectedHostNode = useMemo(
        () => nodes.find(n => daemonIdsEquivalent(String(n.daemon_id || n.daemonId || ''), coordinatorDaemonId)),
        [nodes, coordinatorDaemonId],
    )
    const isHostNodeAttached = features.meshHostDaemonSection ? !!selectedHostNode : true

    // The daemon this mesh is pinned to as its host. The host is a fixed 1:1 pin
    // decided daemon-side at mesh creation, so this is read from persisted meshHost
    // metadata (hostDaemonId, else the daemon of hostNodeId), NOT chosen in the UI.
    //
    // Crucially this must survive the host being offline: when the host daemon is
    // not in the connected `daemons` list we still report `pinned` with a stable id
    // and a best-effort label (from the persisted host node), marked `online:false`,
    // instead of collapsing to '' and re-exposing a picker. Resolution goes through
    // daemonIdsEquivalent because the persisted id is frequently a config-form id
    // that does not byte-equal a connected runtime daemon id.
    const persistedHostInfo = useMemo<{ pinned: boolean; daemonId: string; label: string; online: boolean }>(() => {
        if (!features.meshHostDaemonSection || !selectedMesh) {
            return { pinned: false, daemonId: '', label: '', online: false }
        }
        const meshHost = (selectedMesh as any).meshHost as { hostDaemonId?: string; hostNodeId?: string } | undefined
        const pinnedDaemonId = String(meshHost?.hostDaemonId || '')
        const hostNodeId = String(meshHost?.hostNodeId || '')
        const hostNode = hostNodeId ? nodes.find(n => String(n.id) === hostNodeId) : undefined
        const nodeDaemonId = String(hostNode?.daemon_id || hostNode?.daemonId || '')

        // Effective persisted host daemon id (config-form id is fine — kept as-is so
        // the badge/command target stays stable even when the daemon is offline).
        const effectiveId = pinnedDaemonId || nodeDaemonId
        if (!effectiveId) return { pinned: false, daemonId: '', label: '', online: false }

        // Resolve to a connected runtime daemon if one matches → host is online.
        const connected =
            daemons.find(d => pinnedDaemonId && daemonIdsEquivalent(d.id, pinnedDaemonId)) ||
            (nodeDaemonId ? daemons.find(d => daemonIdsEquivalent(d.id, nodeDaemonId)) : undefined)
        if (connected) {
            return { pinned: true, daemonId: connected.id, label: daemonDisplayLabel(connected), online: true }
        }

        // Host daemon is offline / not connected: preserve the pin and a label from
        // the persisted host node (machineLabel/workspace) so the read-only badge
        // never falls back to a daemon picker. Never blank the id.
        const offlineLabel =
            String((hostNode as any)?.machineLabel || '') ||
            String((hostNode as any)?.workspace || '') ||
            effectiveId
        return { pinned: true, daemonId: effectiveId, label: offlineLabel, online: false }
    }, [selectedMesh, nodes, daemons, features.meshHostDaemonSection])

    const persistedHostDaemonId = persistedHostInfo.daemonId
    const hostOnline = persistedHostInfo.online

    // While the pinned host is offline, route commands through the chosen re-bind
    // daemon (a connected daemon) if one is set and still connected. Otherwise the
    // resolved target is the persisted host id (which may be offline — loads will
    // just fail until reconnect, which the UI surfaces).
    const effectiveCommandDaemonId = useMemo(() => {
        if (!features.meshHostDaemonSection) return ''
        if (!persistedHostInfo.pinned) return ''
        if (!hostOnline && hostRebindDaemonId && daemons.some(d => d.id === hostRebindDaemonId)) {
            return hostRebindDaemonId
        }
        return persistedHostDaemonId
    }, [features.meshHostDaemonSection, persistedHostInfo.pinned, hostOnline, hostRebindDaemonId, daemons, persistedHostDaemonId])

    const meshNodeDaemonIds = useMemo(() => {
        if (!meshGraphStatus) return []
        return [...new Set(
            (meshGraphStatus.nodes ?? [])
                .map((n: any) => String(n.daemonId || n.daemon_id || ''))
                .filter(Boolean)
        )]
    }, [meshGraphStatus])

    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshGraphStatus,
        daemonId: resolvedActiveDaemonId || null,
        extraDaemonIds: meshNodeDaemonIds,
        meshId: selectedMeshId,
        sendData,
    })

    // ─── Effects ────────────────────────────────────────────────

    // Sync node provider priority drafts when selected mesh changes
    useEffect(() => {
        setNodeProviderPriorityDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, readNodeProviderPriority(node)]),
        ))
    }, [selectedMesh])

    // Sync coordinator + node system prompt drafts when selected mesh changes
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

    // Auto-set default provider priority when opening add-node form
    useEffect(() => {
        const defaultPriority = features.addNodeDaemonPicker
            ? defaultProviderPriorityFromInventory(nodePickerProviders)
            : defaultProviderPriorityFromInventory(availableCliProviders)
        if (showAddNode && nodeProviderPriority.length === 0 && defaultPriority.length > 0) {
            setNodeProviderPriority(defaultPriority)
        }
    }, [showAddNode, availableCliProviders, nodePickerProviders, nodeProviderPriority.length, features.addNodeDaemonPicker])

    // Clear selectedNodeId when node is removed from mesh
    useEffect(() => {
        const nodeIds = new Set((selectedMesh?.nodes || []).map(n => n.id))
        if (selectedNodeId && !nodeIds.has(selectedNodeId)) setSelectedNodeId(null)
    }, [selectedMesh, selectedNodeId])

    // Cloud: derive the command/view-source daemon id. There is no host picker —
    // this is computed deterministically:
    //   • pinned host (online or offline) → the persisted host id, unless the host
    //     is offline AND the user picked a re-bind daemon, in which case route
    //     through that connected daemon (effectiveCommandDaemonId encodes both).
    //   • no host pinned yet (first-time setup) → daemons[0] so graph/status loads
    //     and a Launch Host Coordinator action can establish the host daemon-side.
    // Keeping this as the single writer of coordinatorDaemonId is what lets
    // loadGraph/loadMeshStatus/metadata-subscription keep working without a select.
    useEffect(() => {
        if (!features.meshHostDaemonSection) return
        if (!daemons.length && !persistedHostInfo.pinned) { setCoordinatorDaemonId(''); return }
        const target = persistedHostInfo.pinned
            ? effectiveCommandDaemonId
            : (daemons[0]?.id || '')
        if (target && !daemonIdsEquivalent(target, coordinatorDaemonId)) {
            setCoordinatorDaemonId(target)
        }
    }, [daemons, coordinatorDaemonId, persistedHostInfo.pinned, effectiveCommandDaemonId, features.meshHostDaemonSection])

    // Drop a stale re-bind override once the pinned host comes back online (or the
    // chosen re-bind daemon disconnects), so we snap back to commanding the host.
    useEffect(() => {
        if (!hostRebindDaemonId) return
        if (hostOnline || !daemons.some(d => d.id === hostRebindDaemonId)) {
            setHostRebindDaemonId('')
        }
    }, [hostOnline, hostRebindDaemonId, daemons])

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

    // Load graph on mesh or coordinator daemon selection
    useEffect(() => {
        if (selectedMeshId) {
            setMeshGraphStatus(null)
            setGraphError(null)
            void loadGraph(resolvedActiveDaemonId, selectedMeshId)
        }
    }, [selectedMeshId, resolvedActiveDaemonId])

    // Visibility-gated automatic graph revalidation (SWR-style).
    // `loadGraph` is recreated each render, so we read it through a ref to keep
    // the interval stable (re-creating it every render would reset the timer and
    // it would never fire). A guard ref drops a tick while a prior auto-reload is
    // still in flight, so a slow git probe cannot pile up overlapping refreshes.
    // The manual Refresh button (onRefreshGraph) remains the explicit path.
    const loadGraphRef = useRef(loadGraph)
    loadGraphRef.current = loadGraph
    const autoRevalidateInFlight = useRef(false)
    useEffect(() => {
        if (!selectedMeshId || !resolvedActiveDaemonId) return
        if (typeof document === 'undefined') return

        let timer: ReturnType<typeof setInterval> | null = null

        const tick = () => {
            if (document.visibilityState !== 'visible') return
            if (autoRevalidateInFlight.current) return
            autoRevalidateInFlight.current = true
            // refresh=true → SWR semantics: keep the current graph on screen (no
            // loading spinner) and commit the fresh snapshot when it arrives.
            void Promise.resolve(loadGraphRef.current(resolvedActiveDaemonId, selectedMeshId, true))
                .finally(() => { autoRevalidateInFlight.current = false })
        }

        const start = () => {
            if (timer === null) timer = setInterval(tick, GRAPH_AUTO_REVALIDATE_INTERVAL_MS)
        }
        const stop = () => {
            if (timer !== null) { clearInterval(timer); timer = null }
        }

        // Poll only while the tab is visible; pause immediately when hidden and
        // resume when the user returns. No leading tick — the selection effect
        // above already does the first paint.
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') start()
            else stop()
        }
        if (document.visibilityState === 'visible') start()
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [selectedMeshId, resolvedActiveDaemonId])

    // Standalone: auto-load queue on mesh selection. The dedicated Queue settings
    // section is gone, but meshQueue still feeds per-node assignment diagnostics and
    // the scheduler, so the standalone path keeps loading it.
    useEffect(() => {
        if (features.queueSection) return
        void loadQueue(selectedMeshId)
    }, [selectedMeshId, features.queueSection])

    // Initial mesh load
    useEffect(() => { void loadMeshes() }, [loadMeshes])

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
                onCancelCreate={cancelCreate}
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
            onRefreshGraph={() => loadGraph(resolvedActiveDaemonId, selectedMeshId, true)}
            savingPolicy={savingPolicy}
            onUpdatePolicy={handleUpdatePolicy}
            coordinatorPromptDraft={coordinatorPromptDraft}
            onCoordinatorPromptDraftChange={setCoordinatorPromptDraft}
            savingCoordinatorPrompt={savingCoordinatorPrompt}
            onSaveCoordinatorPrompt={handleSaveCoordinatorPrompt}
            daemons={daemons}
            coordinatorDaemonId={coordinatorDaemonId}
            coordinatorCliType={coordinatorCliType}
            onCoordinatorCliTypeChange={setCoordinatorCliType}
            launchingCoordinator={launchingCoordinator}
            launchResult={launchResult}
            isHostNodeAttached={isHostNodeAttached}
            selectedHostNode={selectedHostNode}
            hostPinned={persistedHostInfo.pinned}
            hostLabel={persistedHostInfo.label}
            hostOnline={hostOnline}
            hostRebindDaemonId={hostRebindDaemonId}
            onHostRebindDaemonIdChange={id => { setHostRebindDaemonId(id); setMeshGraphStatus(null) }}
            onLaunchCoordinator={handleLaunchCoordinator}
            activeDaemon={activeDaemon}
            activeDaemonId={resolvedActiveDaemonId}
            meshQueue={meshQueue}
            userName={userName}
            nodeProviderPriorityDrafts={nodeProviderPriorityDrafts}
            onNodeProviderPriorityDraftChange={(nodeId, next) => setNodeProviderPriorityDrafts(prev => ({ ...prev, [nodeId]: next }))}
            availableCliProviders={availableCliProviders}
            savingNodePolicyId={savingNodePolicyId}
            onUpdateNodeProviderPriority={handleUpdateNodeProviderPriority}
            savingNodeSchedulingId={savingNodeSchedulingId}
            onUpdateNodeScheduling={handleUpdateNodeScheduling}
            schedulingStrategy={readMeshPolicy(selectedMesh).schedulingStrategy}
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
                hermesMcpConfig: features.hermesMcpConfig,
                addNodeDaemonPicker: features.addNodeDaemonPicker,
                nodeInstruction: features.nodeInstruction,
            }}
            sendCommand={sendCommand}
        />
    )
}

// ─── Helper ──────────────────────────────────────────────────────

function daemonDisplayLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}

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
