/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useMemo } from 'react'

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
import { useMeshReviewInbox } from './repo-mesh/useMeshReviewInbox'
import type { MeshNode, MeshQueueEntry, AvailableCliAgent } from './repo-mesh/types'

// Re-export types that cloud/standalone wrappers may reference
export type { MeshNode, MeshQueueEntry, AvailableCliAgent }
export { RepoMeshHermesMcpConfig } from './repo-mesh/MeshHermesMcpConfig'
export { getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from './repo-mesh/MeshNodeList'

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
        graphProvenance, graphBootstrapFallback,
        loadGraph,
    } = useMeshGraph({ selectedMeshId, loadMeshStatus, extractStatus, normalizeNode, gateIncompleteGraph })

    // ─── Coordinator daemon selection (cloud) ───
    // Kept here so it can be passed into both useMeshNodeActions and useMeshQueue
    const [coordinatorDaemonId, setCoordinatorDaemonId] = useState('')

    const resolvedActiveDaemonId = features.meshHostDaemonSection
        ? (coordinatorDaemonId || primaryDaemonId)
        : primaryDaemonId

    // ─── Queue ───

    const {
        meshQueue, queueSummary, queueLoading, queueError,
        loadQueue, handleLoadQueue,
    } = useMeshQueue({
        primaryDaemonId,
        activeDaemonId: resolvedActiveDaemonId,
        sendCommand,
        unwrapResult,
        loadLiveMesh,
        resolveCommandTarget,
    })

    // ─── Review Inbox (M4.0) ───

    const {
        items: reviewInboxItems,
        loading: reviewInboxLoading,
        error: reviewInboxError,
        remoteNodesExcluded: reviewInboxRemoteNodesExcluded,
        loadInbox: loadReviewInbox,
        dismissItem: dismissReviewInboxItem,
    } = useMeshReviewInbox({ primaryDaemonId, sendCommand })

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
        handleAddNode, handleRemoveNode, handleUpdatePolicy,
        handleUpdateNodeProviderPriority,
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
        () => nodes.find(n => String(n.daemon_id || n.daemonId || '') === coordinatorDaemonId),
        [nodes, coordinatorDaemonId],
    )
    const isHostNodeAttached = features.meshHostDaemonSection ? !!selectedHostNode : true

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

    // Load graph on mesh or coordinator daemon selection
    useEffect(() => {
        if (selectedMeshId) {
            setMeshGraphStatus(null)
            setGraphError(null)
            void loadGraph(resolvedActiveDaemonId, selectedMeshId)
        }
    }, [selectedMeshId, resolvedActiveDaemonId])

    // Standalone: auto-load queue on mesh selection
    useEffect(() => {
        if (features.queueSection) return
        void loadQueue(selectedMeshId)
    }, [selectedMeshId, features.queueSection])

    // Auto-load review inbox on mesh selection (when feature is enabled)
    useEffect(() => {
        if (!features.reviewInbox || !selectedMeshId) return
        void loadReviewInbox(selectedMeshId)
    }, [selectedMeshId, features.reviewInbox])

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
            graphProvenance={graphProvenance}
            graphBootstrapFallback={graphBootstrapFallback}
            onRefreshGraph={() => loadGraph(resolvedActiveDaemonId, selectedMeshId, true)}
            queueSummary={queueSummary}
            queueLoading={queueLoading}
            queueError={queueError}
            onLoadQueue={() => handleLoadQueue(selectedMesh)}
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
            activeDaemonId={resolvedActiveDaemonId}
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
                reviewInbox: features.reviewInbox ?? false,
            }}
            reviewInboxItems={reviewInboxItems}
            reviewInboxLoading={reviewInboxLoading}
            reviewInboxError={reviewInboxError}
            reviewInboxRemoteNodesExcluded={reviewInboxRemoteNodesExcluded}
            onLoadReviewInbox={() => selectedMeshId && void loadReviewInbox(selectedMeshId)}
            onDismissReviewInboxItem={dismissReviewInboxItem}
            onRefineNode={async (nodeId) => {
                if (!selectedMeshId) return
                await sendCommand(resolvedActiveDaemonId, 'refine_mesh_node', { meshId: selectedMeshId, nodeId, inlineMesh: selectedMesh })
                void loadReviewInbox(selectedMeshId)
            }}
            onRequeueLast={async (nodeId) => {
                if (!selectedMeshId) return
                await sendCommand(resolvedActiveDaemonId, 'requeue_mesh_queue_task', { meshId: selectedMeshId, nodeId })
                void loadReviewInbox(selectedMeshId)
            }}
            sendCommand={sendCommand}
        />
    )
}

// ─── Helper ──────────────────────────────────────────────────────

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
