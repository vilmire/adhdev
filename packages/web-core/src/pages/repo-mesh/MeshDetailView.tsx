import { useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField } from '../../components/ui/FormField'
import { IconMesh } from '../../components/Icons'
import MagiPanelManager from '../../components/MeshGraph/MagiPanelManager'
import DashboardMeshGraphDialog from '../../components/dashboard/DashboardMeshGraphDialog'
import type { ActiveConversation } from '../../components/dashboard/types'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import { MeshMissionsSection } from './MeshMissionsSection'
import { MeshNodeList } from './MeshNodeList'
import { MeshHostDaemonSection } from './MeshHostDaemonSection'
import { RepoMeshHermesMcpConfig } from './MeshHermesMcpConfig'
import CoordinatorPromptsSection from '../../components/settings/CoordinatorPromptsSection'
import { IconRefresh } from './icons'
import {
    readMeshPolicy,
    SESSION_CLEANUP_MODE_OPTIONS,
    DISTRIBUTION_OPTIONS,
    distributionToStrategy,
    strategyToDistribution,
    type MeshEntry,
    type MeshNode,
    type MeshProviderRole,
    type MeshSchedulingStrategy,
    type MeshQueueEntry,
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

    // Graph / live mesh status (drives the MAGI surfaces + the graph dialog launcher)
    displayedMeshStatus: RepoMeshStatus | null
    graphLoading: boolean
    graphError: string | null
    onRefreshGraph: (refresh?: boolean) => void

    // Policy
    savingPolicy: boolean
    onUpdatePolicy: (patch: Record<string, unknown>) => void

    // Coordinator prompt
    coordinatorPromptDraft: { override: string; append: string }
    onCoordinatorPromptDraftChange: (draft: { override: string; append: string }) => void
    savingCoordinatorPrompt: boolean
    onSaveCoordinatorPrompt: () => void

    // Host daemon (cloud). The host is a fixed 1:1 pin — there is no picker. These
    // props feed the read-only host display + the offline command re-bind action.
    daemons: RepoMeshDaemonEntry[]
    coordinatorDaemonId: string
    coordinatorCliType: string
    onCoordinatorCliTypeChange: (type: string) => void
    launchingCoordinator: boolean
    launchResult: string | null
    isHostNodeAttached: boolean
    selectedHostNode: MeshNode | undefined
    hostPinned: boolean
    /** Display label for the pinned host (kept stable even when the host is offline). */
    hostLabel: string
    /** Whether the pinned host daemon is currently connected. */
    hostOnline: boolean
    /** Temporary command-routing override daemon while the host is offline ('' = none). */
    hostRebindDaemonId: string
    onHostRebindDaemonIdChange: (id: string) => void
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

    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

/**
 * Build a minimal synthetic ActiveConversation so the /mesh settings page can launch
 * DashboardMeshGraphDialog without a real coordinator conversation. The dialog only
 * needs `daemonId` + a mesh id (read from `coordinator.meshId` / `settings.meshCoordinatorFor`)
 * to load `mesh_status` and render the observability surface; the live-session overlay
 * (built from `sessionId`) is simply absent here, which the dialog handles gracefully.
 */
function buildMeshGraphLaunchConversation(args: { meshId: string; daemonId: string; meshName: string }): ActiveConversation {
    return {
        routeId: `mesh-settings:${args.meshId}`,
        daemonId: args.daemonId,
        agentName: args.meshName,
        agentType: 'mesh',
        status: 'idle',
        title: args.meshName,
        messages: [],
        workspaceName: args.meshName,
        displayPrimary: args.meshName,
        displaySecondary: 'Mesh observability',
        streamSource: 'native',
        tabKey: `mesh-settings:${args.meshId}`,
        coordinator: { meshId: args.meshId, role: 'coordinator' },
        settings: { meshCoordinatorFor: args.meshId },
    }
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
    onRefreshGraph,
    savingPolicy,
    onUpdatePolicy,
    coordinatorPromptDraft,
    onCoordinatorPromptDraftChange,
    savingCoordinatorPrompt,
    onSaveCoordinatorPrompt,
    daemons,
    coordinatorDaemonId,
    coordinatorCliType,
    onCoordinatorCliTypeChange,
    launchingCoordinator,
    launchResult,
    isHostNodeAttached,
    selectedHostNode,
    hostPinned,
    hostLabel,
    hostOnline,
    hostRebindDaemonId,
    onHostRebindDaemonIdChange,
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
    sendCommand,
}: Props) {
    const policy = readMeshPolicy(selectedMesh)
    const nodes: MeshNode[] = selectedMesh.nodes || []
    // Drives the priority_only → distribution display: a legacy 'priority_only' mesh
    // shows as Spread only when a node priority is actually set (otherwise it is
    // behaviorally identical to 'in_order').
    const anyNodePriorityConfigured = nodes.some(n => {
        const p = Number(n.policy?.schedulingPriority)
        return Number.isFinite(p) && p !== 0
    })

    // Graph/detail observability is now a launched dialog (DashboardMeshGraphDialog),
    // not an embedded surface on the page — the page is the mesh SETTINGS surface.
    const [graphDialogOpen, setGraphDialogOpen] = useState(false)
    const canLaunchGraphDialog = !!activeDaemonId && !!selectedMesh.id

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

            {/* ── Cloud: Mesh host (read-only) ── */}
            {features.meshHostDaemonSection && (
                <MeshHostDaemonSection
                    daemons={daemons}
                    coordinatorDaemonId={coordinatorDaemonId}
                    coordinatorCliType={coordinatorCliType}
                    onCoordinatorCliTypeChange={onCoordinatorCliTypeChange}
                    launchingCoordinator={launchingCoordinator}
                    launchResult={launchResult}
                    isHostNodeAttached={isHostNodeAttached}
                    selectedHostNode={selectedHostNode}
                    hostPinned={hostPinned}
                    hostLabel={hostLabel}
                    hostOnline={hostOnline}
                    hostRebindDaemonId={hostRebindDaemonId}
                    onHostRebindDaemonIdChange={id => { onHostRebindDaemonIdChange(id); onRefreshGraph() }}
                    onLaunchCoordinator={onLaunchCoordinator}
                />
            )}

            {/* ── Observability: graph / detail dialog launcher ──
                 The page no longer embeds the observability surface (graph/overview/status);
                 that surface is reserved for DashboardMeshGraphDialog, which this button
                 launches. The dialog owns its own mesh_status loader + live-session overlay. */}
            <Section title="Observability" description="Open the live mesh graph, overview, and runtime status in the observability dialog.">
                {graphError && <div className="mb-3 text-[12px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">{graphError}</div>}
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
                        onClick={() => setGraphDialogOpen(true)}
                        disabled={!canLaunchGraphDialog}
                        title={canLaunchGraphDialog ? 'Open the mesh graph / overview / status dialog' : 'A coordinator daemon must be selected first'}
                    >
                        <IconMesh size={14} />Open mesh graph & status
                    </button>
                    <span className="text-[12px] text-text-muted">
                        Topology graph, overview cards (missions, ledger, queue, nodes, sessions), and per-node runtime drift.
                    </span>
                </div>
            </Section>

            {/* ── MAGI panels (CRUD) ──
                 Panel create/edit/delete lives ONLY here on the /mesh detail page.
                 The mesh dialog shows panels read-only (MagiPanelOverview); this Section is
                 the single place to mutate them. Same {status, daemonId, sendDaemonCommand}
                 seam the surface uses. */}
            {displayedMeshStatus && (
                <Section title="MAGI panels" description="Saved (machine × AI) cross-verification quorums — machine-local config. Create, edit, or delete them here.">
                    <MagiPanelManager
                        status={displayedMeshStatus}
                        daemonId={activeDaemonId}
                        sendDaemonCommand={sendCommand}
                    />
                </Section>
            )}

            {/* ── Missions (fix b: full-goal fetch-more) ── */}
            <MeshMissionsSection
                status={displayedMeshStatus}
                daemonId={activeDaemonId}
                meshId={selectedMesh.id}
                sendCommand={sendCommand}
            />

            {/* Queue, Review Inbox, and MAGI synthesis are runtime telemetry, not static
                settings — they were removed from this page. Live queue/graph/node-runtime
                truth is reached through the Observability dialog above; review-inbox runtime
                has no settings-page home and is intentionally absent here. */}

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
                    <legend className="text-[13px] font-medium text-text-secondary mb-2">Distribution</legend>
                    <div className="flex flex-col gap-2">
                        {DISTRIBUTION_OPTIONS.map(opt => {
                            const currentDistribution = strategyToDistribution(policy.schedulingStrategy, { priorityConfigured: anyNodePriorityConfigured })
                            const selected = currentDistribution === opt.value
                            return (
                                <label key={opt.value}
                                    className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border-subtle bg-bg-secondary/60 hover:border-border-default'}`}>
                                    <input type="radio" name="mesh-distribution" className="mt-0.5 accent-[var(--accent-primary)]"
                                        value={opt.value} checked={selected} disabled={savingPolicy}
                                        onChange={() => onUpdatePolicy({ schedulingStrategy: distributionToStrategy(opt.value) })} />
                                    <span className="min-w-0">
                                        <span className="block text-sm text-text-primary">{opt.label}</span>
                                        <span className="block text-[12px] text-text-muted">{opt.description}</span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                </fieldset>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">Saving…</div>}
            </Section>

            {/* ── Coordinator prompt (advanced) ──
                 Two axes live here:
                  • Per-mesh: stored in this mesh's coordinator config (systemPromptOverride /
                    systemPromptAppend) via `update_mesh`. Applies only to this mesh.
                  • User-level: per-machine files at ~/.adhdev/coordinator-prompts/<cli>.{md,append.md}
                    on the coordinator daemon, edited via list_/write_coordinator_prompt. Applies to
                    every mesh this daemon coordinates. Relocated here from Settings so it always has
                    a daemon target (activeDaemonId) — on Settings it had no daemon/mesh context and
                    showed "No connected daemons". */}
            {features.coordinatorPrompt && (
                <Section title="Coordinator prompt" collapsible defaultOpen={false}
                    badge={<span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">advanced</span>}
                    description="Customize the system prompt for coordinator sessions. Per-mesh overrides apply to this mesh only; user-level overrides apply to every mesh this daemon coordinates.">

                    {/* Per-mesh override (this mesh's coordinator config) */}
                    <div className="rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
                        <div className="text-[13px] font-semibold mb-1">This mesh</div>
                        <p className="text-[12px] text-text-muted mb-3">Applies only to coordinator sessions for <span className="font-mono text-[11px]">{selectedMesh.name}</span>. Leave empty to fall through to the user-level / daemon default.</p>
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
                    </div>

                    {/* User-level (per-machine files on the coordinator daemon) */}
                    <div className="mt-5 border-t border-border-subtle pt-4">
                        <div className="text-[13px] font-semibold mb-1">User-level (this daemon)</div>
                        <p className="text-[12px] text-text-muted mb-3">
                            Per-machine prompt files on the coordinator daemon. They apply to every mesh this
                            daemon coordinates and are not synced across daemons. Per-mesh overrides above win
                            over these.
                        </p>
                        <CoordinatorPromptsSection daemonId={activeDaemonId || undefined} />
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

            {/* ── Observability dialog (launched from the Observability section) ── */}
            {graphDialogOpen && canLaunchGraphDialog && (
                <DashboardMeshGraphDialog
                    activeConv={buildMeshGraphLaunchConversation({ meshId: selectedMesh.id, daemonId: activeDaemonId, meshName: selectedMesh.name })}
                    sendDaemonCommand={sendCommand}
                    onClose={() => setGraphDialogOpen(false)}
                />
            )}
        </AppPage>
    )
}
