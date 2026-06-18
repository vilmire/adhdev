import type { RepoMeshStatus } from '@adhdev/daemon-core'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField } from '../../components/ui/FormField'
import { IconMesh } from '../../components/Icons'
import { MeshObservabilitySurface } from '../../components/MeshGraph'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import { MeshQueueSection } from './MeshQueueSection'
import { ReviewInboxSection } from './ReviewInboxSection'
import { MeshNodeList } from './MeshNodeList'
import { MeshHostDaemonSection } from './MeshHostDaemonSection'
import { RepoMeshHermesMcpConfig } from './MeshHermesMcpConfig'
import { IconRefresh } from './icons'
import {
    readMeshPolicy,
    resolveMeshRoleOptions,
    SESSION_CLEANUP_MODE_OPTIONS,
    SCHEDULING_STRATEGY_OPTIONS,
    type MeshEntry,
    type MeshNode,
    type MeshProviderRole,
    type MeshSchedulingStrategy,
    type MeshQueueEntry,
    type MeshQueueSummary,
    type MeshDetailViewFeatures,
    type ProviderPriorityDrafts,
    type AvailableCliAgent,
} from './types'

interface Props {
    selectedMesh: MeshEntry
    error: string | null
    onDismissError: () => void
    onBack: () => void
    onDelete: (meshId: string) => void

    // Graph
    displayedMeshStatus: RepoMeshStatus | null
    graphLoading: boolean
    graphError: string | null
    graphProvenance: 'idle' | 'first_paint' | 'settling' | 'settled'
    graphBootstrapFallback?: boolean
    onRefreshGraph: (refresh?: boolean) => void

    // Queue
    queueSummary: MeshQueueSummary | null
    queueLoading: boolean
    queueError: string | null
    onLoadQueue: () => void

    // Policy
    savingPolicy: boolean
    onUpdatePolicy: (patch: Record<string, unknown>) => void

    // Coordinator prompt
    coordinatorPromptDraft: { override: string; append: string }
    onCoordinatorPromptDraftChange: (draft: { override: string; append: string }) => void
    savingCoordinatorPrompt: boolean
    onSaveCoordinatorPrompt: () => void

    // Host daemon (cloud)
    daemons: RepoMeshDaemonEntry[]
    coordinatorDaemonId: string
    onCoordinatorDaemonIdChange: (id: string) => void
    coordinatorCliType: string
    onCoordinatorCliTypeChange: (type: string) => void
    launchingCoordinator: boolean
    launchResult: string | null
    attachedDaemonIds: Set<string>
    isHostNodeAttached: boolean
    selectedHostNode: MeshNode | undefined
    onLaunchCoordinator: () => void

    // Node list
    activeDaemon: RepoMeshDaemonEntry | undefined
    activeDaemonId: string
    meshQueue: MeshQueueEntry[]
    userName?: string
    nodeProviderPriorityDrafts: ProviderPriorityDrafts
    onNodeProviderPriorityDraftChange: (nodeId: string, next: string[]) => void
    availableCliProviders: AvailableCliProviderOption[]
    savingNodePolicyId: string | null
    onUpdateNodeProviderPriority: (node: MeshNode) => void
    savingNodeSchedulingId: string | null
    onUpdateNodeScheduling: (node: MeshNode, patch: { schedulingPriority?: number; providerRoles?: MeshProviderRole[] }) => void
    schedulingStrategy: MeshSchedulingStrategy
    nodeSystemPromptDrafts: Record<string, string>
    onNodeSystemPromptDraftChange: (nodeId: string, value: string) => void
    savingNodeSystemPromptId: string | null
    onSaveNodeSystemPrompt: (node: MeshNode) => void
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void

    // Add node
    showAddNode: boolean
    onShowAddNode: () => void
    onCancelAddNode: () => void
    nodeWorkspace: string
    onNodeWorkspaceChange: (v: string) => void
    nodeProviderPriority: string[]
    onNodeProviderPriorityChange: (v: string[]) => void
    nodeDaemonId: string
    onNodeDaemonIdChange: (id: string) => void
    nodeCustomPath: boolean
    onNodeCustomPathChange: (v: boolean) => void
    nodePickerWorkspaces: Array<{ id?: string; path: string; label?: string | null }>
    nodePickerProviders: AvailableCliProviderOption[]
    attachableDaemons: RepoMeshDaemonEntry[]
    onAddNode: () => void
    onRemoveNode: (nodeId: string) => void

    // Hermes
    availableCliAgents: AvailableCliAgent[]

    features: MeshDetailViewFeatures

    // Review Inbox (M4.0) — required when features.reviewInbox is true
    reviewInboxItems: import('@adhdev/daemon-core').MeshReviewInboxItem[]
    reviewInboxLoading: boolean
    reviewInboxError: string | null
    reviewInboxRemoteNodesExcluded: boolean
    onLoadReviewInbox: () => void
    onDismissReviewInboxItem: (nodeId: string) => void
    onRefineNode: (nodeId: string) => void
    onRequeueLast: (nodeId: string) => void

    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export function MeshDetailView({
    selectedMesh,
    error,
    onDismissError,
    onBack,
    onDelete,
    displayedMeshStatus,
    graphLoading,
    graphError,
    graphProvenance,
    graphBootstrapFallback = false,
    onRefreshGraph,
    queueSummary,
    queueLoading,
    queueError,
    onLoadQueue,
    savingPolicy,
    onUpdatePolicy,
    coordinatorPromptDraft,
    onCoordinatorPromptDraftChange,
    savingCoordinatorPrompt,
    onSaveCoordinatorPrompt,
    daemons,
    coordinatorDaemonId,
    onCoordinatorDaemonIdChange,
    coordinatorCliType,
    onCoordinatorCliTypeChange,
    launchingCoordinator,
    launchResult,
    attachedDaemonIds,
    isHostNodeAttached,
    selectedHostNode,
    onLaunchCoordinator,
    activeDaemon,
    activeDaemonId,
    meshQueue,
    userName,
    nodeProviderPriorityDrafts,
    onNodeProviderPriorityDraftChange,
    availableCliProviders,
    savingNodePolicyId,
    onUpdateNodeProviderPriority,
    savingNodeSchedulingId,
    onUpdateNodeScheduling,
    schedulingStrategy,
    nodeSystemPromptDrafts,
    onNodeSystemPromptDraftChange,
    savingNodeSystemPromptId,
    onSaveNodeSystemPrompt,
    selectedNodeId,
    onSelectNode,
    showAddNode,
    onShowAddNode,
    onCancelAddNode,
    nodeWorkspace,
    onNodeWorkspaceChange,
    nodeProviderPriority,
    onNodeProviderPriorityChange,
    nodeDaemonId,
    onNodeDaemonIdChange,
    nodeCustomPath,
    onNodeCustomPathChange,
    nodePickerWorkspaces,
    nodePickerProviders,
    attachableDaemons,
    onAddNode,
    onRemoveNode,
    availableCliAgents,
    features,
    reviewInboxItems,
    reviewInboxLoading,
    reviewInboxError,
    reviewInboxRemoteNodesExcluded,
    onLoadReviewInbox,
    onDismissReviewInboxItem,
    onRefineNode,
    onRequeueLast,
    sendCommand,
}: Props) {
    const policy = readMeshPolicy(selectedMesh)
    const nodes: MeshNode[] = selectedMesh.nodes || []
    // Dashboard role dropdown options: the four standard roles plus any roles declared
    // in this mesh's taskAffinity policy (byTaskMode values + customRoles). Shared with
    // the daemon's affinity resolver so the UI and routing agree on the role set.
    const roleOptions = resolveMeshRoleOptions(policy.taskAffinity)

    return (
        <AppPage
            icon={<IconMesh />}
            title={selectedMesh.name}
            subtitle={selectedMesh.repoIdentity || (selectedMesh as any).repo_identity || 'Repo Mesh'}
            widthClassName="max-w-5xl"
            actions={
                <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
                    <button className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => onRefreshGraph(true)} disabled={graphLoading}>
                        <IconRefresh size={13} />{graphLoading ? 'Probing…' : 'Refresh'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => onDelete(selectedMesh.id)}>Delete</button>
                </div>
            }
        >
            {error && <AlertBanner variant="error" onDismiss={onDismissError} className="mb-4">{error}</AlertBanner>}

            {/* ── Cloud: Coordinator machine ── */}
            {features.meshHostDaemonSection && (
                <MeshHostDaemonSection
                    daemons={daemons}
                    coordinatorDaemonId={coordinatorDaemonId}
                    onCoordinatorDaemonIdChange={id => { onCoordinatorDaemonIdChange(id); onRefreshGraph() }}
                    coordinatorCliType={coordinatorCliType}
                    onCoordinatorCliTypeChange={onCoordinatorCliTypeChange}
                    launchingCoordinator={launchingCoordinator}
                    launchResult={launchResult}
                    attachedDaemonIds={attachedDaemonIds}
                    isHostNodeAttached={isHostNodeAttached}
                    selectedHostNode={selectedHostNode}
                    onLaunchCoordinator={onLaunchCoordinator}
                    onAttachSelectedHost={() => { onNodeDaemonIdChange(coordinatorDaemonId); onShowAddNode() }}
                />
            )}

            {/* ── Cloud: Queue section ── */}
            {features.queueSection && (
                <MeshQueueSection
                    queueSummary={queueSummary}
                    queueLoading={queueLoading}
                    queueError={queueError}
                    activeDaemonId={activeDaemonId}
                    onRefresh={onLoadQueue}
                />
            )}

            {/* ── Mesh overview + graph (tabbed inside the surface) ── */}
            <Section title="Mesh" description="Overview cards (missions, ledger, queue, nodes, sessions) with the live topology graph behind the Graph tab.">
                <div className="mb-4 text-[12px] text-text-muted max-w-2xl">
                    {features.meshHostDaemonSection
                        ? <>Direct aggregate mesh_status from the selected Mesh Host is preferred. Use Refresh above to ask the host for the latest peer git provenance.{graphProvenance === 'settling' && <span className="ml-1 text-amber-300">Refreshing peer data…</span>}</>
                        : <>Overview shows live mesh state as cards; switch to the Graph tab for the topology view.</>
                    }
                </div>
                {graphBootstrapFallback && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-200">
                        <span className="mt-0.5 shrink-0 text-amber-400" aria-hidden>⚠</span>
                        <span>Connecting to coordinator — showing setup inventory. Live data will appear shortly.</span>
                    </div>
                )}
                {graphError && <div className="mb-3 text-[12px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">{graphError}</div>}
                {!displayedMeshStatus ? (
                    <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">
                        {graphLoading ? 'Loading graph...' : features.meshHostDaemonSection
                            ? 'No mesh graph data is available yet. Refresh after the selected Mesh Host is reachable.'
                            : 'Refresh the graph to inspect queue activity, sessions, node drift, and mesh topology.'}
                    </div>
                ) : (
                    <MeshObservabilitySurface
                        status={displayedMeshStatus}
                        emptyMessage={features.meshHostDaemonSection
                            ? 'No mesh graph data is available yet. Refresh after the selected Mesh Host is reachable.'
                            : 'Refresh the graph to inspect queue activity, sessions, node drift, and mesh topology.'}
                        daemonId={activeDaemonId}
                        sendDaemonCommand={sendCommand}
                        bootstrapFallback={graphBootstrapFallback}
                    />
                )}
            </Section>

            {/* ── Review Inbox (M4.0) ── */}
            {features.reviewInbox && (
                <ReviewInboxSection
                    items={reviewInboxItems}
                    loading={reviewInboxLoading}
                    error={reviewInboxError}
                    remoteNodesExcluded={reviewInboxRemoteNodesExcluded}
                    meshId={selectedMesh.id}
                    activeDaemonId={activeDaemonId}
                    onRefresh={onLoadReviewInbox}
                    onDismiss={onDismissReviewInboxItem}
                    onRefineNode={onRefineNode}
                    onRequeueLast={onRequeueLast}
                    sendCommand={sendCommand}
                />
            )}

            {/* ── Nodes & Providers ── */}
            <MeshNodeList
                nodes={nodes}
                meshQueue={meshQueue}
                activeDaemon={activeDaemon}
                daemons={daemons}
                selectedMeshId={selectedMesh.id}
                userName={userName}
                features={{ addNodeDaemonPicker: features.addNodeDaemonPicker, nodeInstruction: features.nodeInstruction }}
                coordinatorDaemonId={coordinatorDaemonId}
                schedulingStrategy={schedulingStrategy}
                roleOptions={roleOptions}
                nodeProviderPriorityDrafts={nodeProviderPriorityDrafts}
                onNodeProviderPriorityDraftChange={onNodeProviderPriorityDraftChange}
                availableCliProviders={availableCliProviders}
                savingNodePolicyId={savingNodePolicyId}
                onUpdateNodeProviderPriority={onUpdateNodeProviderPriority}
                savingNodeSchedulingId={savingNodeSchedulingId}
                onUpdateNodeScheduling={onUpdateNodeScheduling}
                nodeSystemPromptDrafts={nodeSystemPromptDrafts}
                onNodeSystemPromptDraftChange={onNodeSystemPromptDraftChange}
                savingNodeSystemPromptId={savingNodeSystemPromptId}
                onSaveNodeSystemPrompt={onSaveNodeSystemPrompt}
                selectedNodeId={selectedNodeId}
                onSelectNode={onSelectNode}
                showAddNode={showAddNode}
                onShowAddNode={onShowAddNode}
                onCancelAddNode={onCancelAddNode}
                nodeWorkspace={nodeWorkspace}
                onNodeWorkspaceChange={onNodeWorkspaceChange}
                nodeProviderPriority={nodeProviderPriority}
                onNodeProviderPriorityChange={onNodeProviderPriorityChange}
                nodeDaemonId={nodeDaemonId}
                onNodeDaemonIdChange={onNodeDaemonIdChange}
                nodeCustomPath={nodeCustomPath}
                onNodeCustomPathChange={onNodeCustomPathChange}
                nodePickerWorkspaces={nodePickerWorkspaces}
                nodePickerProviders={nodePickerProviders}
                attachableDaemons={attachableDaemons}
                onAddNode={onAddNode}
                onRemoveNode={onRemoveNode}
            />

            {/* ── Scheduling ── */}
            <Section title="Scheduling" description="How untargeted queue work is distributed across eligible nodes.">
                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Max parallel tasks" hint="Cap on concurrently assigned tasks across the mesh.">
                        <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={String(policy.maxParallelTasks ?? 2)} onChange={e => onUpdatePolicy({ maxParallelTasks: Number(e.target.value) })} disabled={savingPolicy}>
                            {[1, 2, 3, 4, 5, 6, 7, 8].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                    </FormField>
                </div>
                <fieldset className="mt-4 border-none p-0 m-0">
                    <legend className="text-[13px] font-medium text-text-secondary mb-2">Distribution strategy</legend>
                    <div className="flex flex-col gap-2">
                        {SCHEDULING_STRATEGY_OPTIONS.map(opt => {
                            const selected = (policy.schedulingStrategy || 'first_eligible') === opt.value
                            return (
                                <label key={opt.value}
                                    className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border-subtle bg-bg-secondary/60 hover:border-border-default'}`}>
                                    <input type="radio" name="mesh-scheduling-strategy" className="mt-0.5 accent-[var(--accent-primary)]"
                                        value={opt.value} checked={selected} disabled={savingPolicy}
                                        onChange={() => onUpdatePolicy({ schedulingStrategy: opt.value })} />
                                    <span className="min-w-0">
                                        <span className="block text-sm text-text-primary">{opt.label}</span>
                                        <span className="block text-[12px] text-text-muted">{opt.description}</span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                    {(policy.schedulingStrategy === 'priority_only' || policy.schedulingStrategy === 'least_loaded' || policy.schedulingStrategy === 'round_robin') && (
                        <div className="mt-2 text-[12px] text-text-muted">
                            Per-node scheduling priority is set in each node's <span className="text-text-secondary">Advanced</span> panel above.
                        </div>
                    )}
                </fieldset>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">Saving…</div>}
            </Section>

            {/* ── Coordinator prompt (advanced) ── */}
            {features.coordinatorPrompt && (
                <Section title="Coordinator prompt" collapsible defaultOpen={false}
                    badge={<span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">advanced</span>}
                    description="Customize the system prompt for coordinator sessions. Leave empty to use the daemon default.">
                    <FormField label="Override (replaces default)" hint="When set, replaces the daemon's default base prompt. Leave empty to keep the default.">
                        <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                            rows={6} value={coordinatorPromptDraft.override}
                            onChange={e => onCoordinatorPromptDraftChange({ ...coordinatorPromptDraft, override: e.target.value })}
                            disabled={savingCoordinatorPrompt} placeholder="(empty — daemon default applies)" />
                    </FormField>
                    <FormField label="Append (added after the base)" hint="Always added after whichever base prompt wins.">
                        <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                            rows={4} value={coordinatorPromptDraft.append}
                            onChange={e => onCoordinatorPromptDraftChange({ ...coordinatorPromptDraft, append: e.target.value })}
                            disabled={savingCoordinatorPrompt} placeholder="(empty — nothing appended)" />
                    </FormField>
                    <details className="mt-2 text-[12px] text-text-muted">
                        <summary className="cursor-pointer select-none">Available placeholders</summary>
                        <p className="mt-1 font-mono break-words">
                            {'{{meshName}}, {{repo}}, {{defaultBranch}}, {{cliType}}, {{nodes}}, {{policy}}, {{tools}}, {{workflow}}, {{rules}}, {{toolExposurePreflight}}'}
                        </p>
                    </details>
                    <div className="mt-3 flex items-center gap-2">
                        <button type="button" className="btn btn-primary btn-sm" onClick={onSaveCoordinatorPrompt} disabled={savingCoordinatorPrompt}>
                            {savingCoordinatorPrompt ? 'Saving…' : 'Save coordinator prompt'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCoordinatorPromptDraftChange({ override: '', append: '' })} disabled={savingCoordinatorPrompt} title="Clear both fields. Click Save to commit.">Clear</button>
                    </div>
                </Section>
            )}

            {/* ── Safety & Git (advanced) ── */}
            <Section title="Safety & Git" collapsible defaultOpen={false}
                badge={<span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">advanced</span>}
                description="Checkpointing, approval gates, and git safety behavior for coordinator-driven tasks.">
                <div className="grid gap-4 sm:grid-cols-2">
                    {[
                        { label: 'Auto-commit a checkpoint before each task', key: 'requirePreTaskCheckpoint', opts: [['no', 'No'], ['yes', 'Yes']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: 'Auto-commit a checkpoint after each task', key: 'requirePostTaskCheckpoint', opts: [['yes', 'Yes'], ['no', 'No']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: 'Push approval', key: 'requireApprovalForPush', opts: [['required', 'Require approval before push'], ['not_required', 'Do not require approval']], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: 'Destructive git approval', key: 'requireApprovalForDestructiveGit', opts: [['required', 'Require approval'], ['not_required', 'Do not require approval']], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: 'When the workspace has uncommitted changes', key: 'dirtyWorkspaceBehavior', opts: [['warn', 'Warn and continue'], ['block', 'Block task'], ['checkpoint_then_continue', 'Checkpoint then continue']], val: (v: any) => v || 'warn', parse: (v: string) => v },
                        { label: 'Auto-publish submodule commits (advanced)', key: 'allowAutoPublishSubmoduleMainCommits', opts: [['disabled', 'Require explicit approval'], ['enabled', 'Allow Refinery non-force publish']], val: (v: any) => v ? 'enabled' : 'disabled', parse: (v: string) => v === 'enabled' },
                    ].map(({ label, key, opts, val, parse }) => (
                        <FormField key={key} label={label}>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={val(policy[key])} onChange={e => onUpdatePolicy({ [key]: parse(e.target.value) })} disabled={savingPolicy}>
                                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </FormField>
                    ))}
                </div>
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                    <FormField label="When removing a node, its sessions…" hint="Separate transcript cleanup from runtime/process cleanup.">
                        <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.sessionCleanupOnNodeRemove || 'preserve'} onChange={e => onUpdatePolicy({ sessionCleanupOnNodeRemove: e.target.value })} disabled={savingPolicy}>
                            {SESSION_CLEANUP_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                    </FormField>
                    <div className="mt-2 text-[12px] text-text-muted">
                        {SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove)?.description || SESSION_CLEANUP_MODE_OPTIONS[0].description}
                    </div>
                </div>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">Saving…</div>}
            </Section>

            {/* ── Integrations: Standalone Hermes MCP config ── */}
            {features.hermesMcpConfig && (
                <RepoMeshHermesMcpConfig meshId={selectedMesh.id} availableCliAgents={availableCliAgents} />
            )}

            {/* ── Integrations: Cloud MCP hint ── */}
            {features.meshHostDaemonSection && (
                <AlertBanner variant="info" className="mt-4">
                    <strong>MCP Mode:</strong>{' '}
                    <code className="bg-bg-secondary px-1 rounded text-xs">adhdev mcp --repo-mesh {selectedMesh.id}</code>
                    {' · The mesh MCP server can be used directly from your CLI agent.'}
                </AlertBanner>
            )}
        </AppPage>
    )
}

