import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshStatus, RepoMeshQuotaRoutingPolicy } from '@adhdev/daemon-core'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField } from '../../components/ui/FormField'
import { SettingsTabs, type SettingsTab } from '../../components/ui/SettingsTabs'
import { IconMesh } from '../../components/Icons'
// The task_kind → panel binding editor (MagiKindPanelEditor) is the sole MAGI panel
// surface — the named-panel CRUD (MagiPanelManager) was removed.
import MagiKindPanelEditor from '../../components/MeshGraph/MagiKindPanelEditor'
import QuotaPolicyStep from '../../components/setup-wizard/QuotaPolicyStep'
import CoordinatorPromptDefaultPreview from './CoordinatorPromptDefaultPreview'
import DashboardMeshGraphDialog from '../../components/dashboard/DashboardMeshGraphDialog'
import type { ActiveConversation } from '../../components/dashboard/types'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import { collectMeshProviderInventory } from './node-providers'
import { MeshMissionsSection } from './MeshMissionsSection'
import { MeshProviderAutoApproveSection } from './MeshProviderAutoApproveSection'
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
    type MeshDistribution,
    type MeshQueueEntry,
    type MeshDetailViewFeatures,
    type AvailableCliAgent,
    type NodeCapabilitySlot,
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
    /** First-setup host picker: set the host daemon when no authoritative pin exists yet. */
    onCoordinatorDaemonIdChange: (id: string) => void
    /** Still read by CoordinatorPromptDefaultPreview below — NOT dead despite no
     *  longer being passed into MeshHostDaemonSection (host-launch UI removed there). */
    coordinatorCliType: string
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
    /** True while the explicit first-setup host pin is being persisted. */
    settingMeshHost?: boolean
    /** Persist the operator's first-setup host choice (HOST-PIN-WRITER). */
    onSetMeshHost?: (hostDaemonId: string) => void

    // Node list
    activeDaemon: RepoMeshDaemonEntry | undefined
    activeDaemonId: string
    meshQueue: MeshQueueEntry[]
    userName?: string
    availableCliProviders: AvailableCliProviderOption[]
    savingNodeSlotsId: string | null
    onUpdateNodeSlots: (node: MeshNode, slots: NodeCapabilitySlot[]) => void
    savingNodeCapabilitiesId: string | null
    onUpdateNodeCapabilities: (node: MeshNode, capabilities: string[]) => void
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
    nodeOnboardingPlan: any
    nodePlanLoading: boolean
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
    onCoordinatorDaemonIdChange,
    coordinatorCliType,
    isHostNodeAttached,
    selectedHostNode,
    hostPinned,
    hostLabel,
    hostOnline,
    hostRebindDaemonId,
    onHostRebindDaemonIdChange,
    settingMeshHost,
    onSetMeshHost,
    activeDaemon,
    activeDaemonId,
    meshQueue,
    userName,
    availableCliProviders,
    savingNodeSlotsId,
    onUpdateNodeSlots,
    savingNodeCapabilitiesId,
    onUpdateNodeCapabilities,
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
    nodeOnboardingPlan,
    nodePlanLoading,
    attachableDaemons,
    onAddNode,
    onRemoveNode,
    availableCliAgents,
    features,
    sendCommand,
}: Props) {
    const { t } = useTranslation('common')
    const policy = readMeshPolicy(selectedMesh)
    const nodes: MeshNode[] = selectedMesh.nodes || []
    // Provider inventory for the auto-approve surface: the UNION across this mesh's
    // nodes, not just the coordinator daemon's own. Auto-approve defaults are written
    // to the repo's mesh.json and apply to whichever node runs a delegated worker, so
    // a provider installed only on a member machine must be configurable here too.
    // Routed through `nodes` (not `daemons` wholesale) so daemons belonging to other
    // meshes never contribute providers this mesh cannot launch.
    const meshProviderInventory = useMemo(
        () => collectMeshProviderInventory(nodes, daemons),
        [nodes, daemons],
    )
    // Drives the priority_only → distribution display: a legacy 'priority_only' mesh
    // shows as Smart only when a node priority is actually set (otherwise it is
    // behaviorally identical to 'in_order').
    const anyNodePriorityConfigured = nodes.some(n => {
        const p = Number(n.policy?.schedulingPriority)
        return Number.isFinite(p) && p !== 0
    })
    // Distribution recommendation (display-only — the stored default stays
    // 'first_eligible'/In order so meshes.json is untouched). While the operator
    // hasn't explicitly chosen a strategy (schedulingStrategy still unset):
    //  • any node with capability slots → Smart (the daemon already auto-routes by
    //    fitness; the badge just makes the active behavior visible), else
    //  • multiple nodes → Smart (it spreads by priority/load even without slots —
    //    In order would pin everything to the first node).
    // Once the operator picks a strategy, no nudge.
    const distributionUnset = !policy.schedulingStrategy
    const anyNodeHasSlots = useMemo(
        () => nodes.some(n => Array.isArray((n.policy as any)?.slots) && (n.policy as any).slots.length > 0),
        [nodes],
    )
    const recommendedDistribution: MeshDistribution | null = !distributionUnset
        ? null
        : (anyNodeHasSlots || nodes.length >= 2) ? 'smart' : null

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
                    <button className="btn btn-secondary btn-sm" onClick={onBack}>{t('repoMesh.detail.back')}</button>
                    <button className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => onRefreshGraph(true)} disabled={graphLoading}>
                        <IconRefresh size={13} />{graphLoading ? t('repoMesh.detail.probing') : t('repoMesh.detail.refresh')}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => onDelete(selectedMesh.id)}>{t('repoMesh.detail.delete')}</button>
                </div>
            }
        >
            {error && <AlertBanner variant="error" onDismiss={onDismissError} className="mb-4">{error}</AlertBanner>}

            {(() => {
            // Section order below follows the setup flow: add nodes first, then decide how
            // work is scheduled across them, then configure MAGI review panels, then
            // runtime telemetry (missions). Brain presets (difficulty → model/thinking)
            // are absorbed into per-node capability slots (ORCHESTRATION_NODE_SLOTS.md):
            // each node slot declares the difficulty range it handles plus its
            // provider/model/thinking, so the mesh-wide difficulty→brain mapping is no
            // longer a separate surface — edit per-node in "Nodes & Providers".

            const nodesTabContent = (
            <>
            {/* ── Cloud: Mesh host (read-only) ── */}
            {features.meshHostDaemonSection && (
                <MeshHostDaemonSection
                    daemons={daemons}
                    coordinatorDaemonId={coordinatorDaemonId}
                    onCoordinatorDaemonIdChange={onCoordinatorDaemonIdChange}
                    isHostNodeAttached={isHostNodeAttached}
                    selectedHostNode={selectedHostNode}
                    hostPinned={hostPinned}
                    hostLabel={hostLabel}
                    hostOnline={hostOnline}
                    hostRebindDaemonId={hostRebindDaemonId}
                    onHostRebindDaemonIdChange={id => { onHostRebindDaemonIdChange(id); onRefreshGraph() }}
                    settingMeshHost={settingMeshHost}
                    onSetMeshHost={onSetMeshHost}
                />
            )}

            {/* ── Observability: graph / detail dialog launcher ──
                 The page no longer embeds the observability surface (graph/overview/status);
                 that surface is reserved for DashboardMeshGraphDialog, which this button
                 launches. The dialog owns its own mesh_status loader + live-session overlay. */}
            <Section title={t('repoMesh.detail.observabilityTitle')} description={t('repoMesh.detail.observabilityDescription')}>
                {graphError && <div className="mb-3 text-[12px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">{graphError}</div>}
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
                        onClick={() => setGraphDialogOpen(true)}
                        disabled={!canLaunchGraphDialog}
                        title={canLaunchGraphDialog ? t('repoMesh.detail.observabilityOpenTitle') : t('repoMesh.detail.observabilityDisabledTitle')}
                    >
                        <IconMesh size={14} />{t('repoMesh.detail.observabilityOpen')}
                    </button>
                    <span className="text-[12px] text-text-muted">
                        {t('repoMesh.detail.observabilityHint')}
                    </span>
                </div>
            </Section>

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
                availableCliProviders={availableCliProviders}
                savingNodeSlotsId={savingNodeSlotsId}
                onUpdateNodeSlots={onUpdateNodeSlots}
                savingNodeCapabilitiesId={savingNodeCapabilitiesId}
                onUpdateNodeCapabilities={onUpdateNodeCapabilities}
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
                nodeOnboardingPlan={nodeOnboardingPlan}
                nodePlanLoading={nodePlanLoading}
                attachableDaemons={attachableDaemons}
                onAddNode={onAddNode}
                onRemoveNode={onRemoveNode}
            />
            </>
            )

            const schedulingTabContent = (
            <>
            {/* ── Scheduling ── */}
            <Section title={t('repoMesh.detail.schedulingTitle')} description={t('repoMesh.detail.schedulingDescription')}>
                {/* Mesh-level "Max parallel tasks" is hidden: the real concurrency
                    limits live per node / per capability slot (ORCHESTRATION_NODE_SLOTS.md),
                    so a global cap has little meaning. The policy field still exists and
                    defaults high — set it via the API only if you genuinely need a
                    mesh-wide ceiling. */}
                <fieldset className="border-none p-0 m-0">
                    <legend className="text-[13px] font-medium text-text-secondary mb-2">{t('repoMesh.detail.distribution')}</legend>
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
                                        <span className="flex items-center gap-2 text-sm text-text-primary">
                                            {t(opt.labelKey)}
                                            {recommendedDistribution === opt.value && (
                                                <span className="rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-primary">{t('repoMesh.detail.recommended')}</span>
                                            )}
                                        </span>
                                        <span className="block text-[12px] text-text-muted">{t(opt.descriptionKey)}</span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                </fieldset>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">{t('repoMesh.detail.saving')}</div>}

                {/* Per-node scheduling knobs (priority + per-provider max-parallel) were
                    removed: capability slots absorb both — slot order = preference and
                    slot.maxParallel = the per-slot concurrency cap — so editing them lives
                    entirely in each node's "Preferred AI tools" slot list under Nodes &
                    Providers. The daemon still reads legacy providerPriority for
                    back-compat; this page just no longer offers a second place to set it. */}
            </Section>

            {/* ── Dashboard visibility ──
                 Surfaced as a primary (non-advanced) control: it decides whether the
                 worker sessions the coordinator spawns clutter the operator's dashboard
                 inbox + notifications, which most operators want to control. Same
                 policy.spawnedSessionVisibility binding as before (moved out of the
                 collapsed "Safety & Git" advanced accordion for discoverability). */}
            <Section title={t('repoMesh.detail.visibilityTitle')} description={t('repoMesh.detail.visibilityDescription')}>
                <FormField label={t('repoMesh.detail.visibilityLabel')}
                    hint={t('repoMesh.detail.visibilityHint')}>
                    <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                        value={policy.spawnedSessionVisibility === 'visible' ? 'visible' : 'hidden'}
                        onChange={e => onUpdatePolicy({ spawnedSessionVisibility: e.target.value === 'visible' ? 'visible' : 'hidden' })}
                        disabled={savingPolicy}>
                        <option value="hidden">{t('repoMesh.detail.visibilityHidden')}</option>
                        <option value="visible">{t('repoMesh.detail.visibilityVisible')}</option>
                    </select>
                </FormField>
            </Section>

            {/* ── MAGI task_kind → panel binding editor ──
                 Placed after Nodes & Scheduling: MAGI panels reference the nodes/providers
                 configured above. The sole MAGI panel surface — the named-panel CRUD
                 (MagiPanelManager) and its magi_panel_* daemon commands were removed; only
                 magi_kind_panel_* remains. */}
            {displayedMeshStatus && (
                <Section title={t('repoMesh.detail.magiTitle')} description={t('repoMesh.detail.magiDescription')}>
                    <MagiKindPanelEditor
                        status={displayedMeshStatus}
                        daemonId={activeDaemonId}
                        sendDaemonCommand={sendCommand}
                        availableProviders={availableCliProviders}
                    />
                </Section>
            )}

            {/* ── Quota-aware routing thresholds (policy.quotaRouting) ──
                 Placed next to MAGI: both are coordinator-side routing knobs that
                 read the same mesh status/provider surface. Saved through the
                 generic onUpdatePolicy → update_mesh path (same as every other
                 policy field on this page), not the dedicated
                 mesh_quota_routing_set command — quotaRouting is just a field on
                 RepoMeshPolicy, so the shallow-merge patch here is sufficient. */}
            <Section>
                <QuotaPolicyStep
                    quotaRouting={(policy.quotaRouting as RepoMeshQuotaRoutingPolicy | undefined) ?? null}
                    saving={savingPolicy}
                    error={error}
                    onSave={quotaRouting => onUpdatePolicy({ quotaRouting })}
                />
            </Section>

            {/* ── Provider auto-approve defaults (repo mesh.json providerDefaults) ──
                 Three-section surface: repo default (committed) / this machine's
                 authorization (local) / effective result with downgrade reasons. The
                 host daemon owns the repo workspace's .adhdev/mesh.json read/write,
                 while the provider inventory (with autoApproveModes) is the union
                 across this mesh's nodes — a member machine's provider is
                 configurable here too. */}
            <MeshProviderAutoApproveSection
                hostDaemonId={coordinatorDaemonId}
                hostOnline={hostOnline}
                hostWorkspace={selectedHostNode?.workspace || ''}
                meshProviders={meshProviderInventory.providers}
                unreportedNodeCount={meshProviderInventory.unreportedNodeCount}
                machineAutoApproveEnabled={policy.delegatedWorkerAutoApprove !== false}
                machineDangerousAllowed={policy.delegatedWorkerDangerousModeAllow === true}
                onUpdatePolicy={onUpdatePolicy}
                savingPolicy={savingPolicy}
                sendCommand={sendCommand}
            />
            </>
            )

            const promptsTabContent = (
            <>
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
                <Section title={t('repoMesh.detail.coordinatorPromptTitle')} collapsible defaultOpen={false}
                    badge={<span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">{t('repoMesh.detail.advanced')}</span>}
                    description={t('repoMesh.detail.coordinatorPromptDescription')}>

                    {/* Per-mesh override (this mesh's coordinator config) */}
                    <div className="rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
                        <div className="text-[13px] font-semibold mb-1">{t('repoMesh.detail.thisMesh')}</div>
                        <p className="text-[12px] text-text-muted mb-3">{t('repoMesh.detail.thisMeshHint', { name: selectedMesh.name })}</p>
                        <FormField label={t('repoMesh.detail.overrideLabel')} hint={t('repoMesh.detail.overrideHint')}>
                            <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                                rows={6} value={coordinatorPromptDraft.override}
                                onChange={e => onCoordinatorPromptDraftChange({ ...coordinatorPromptDraft, override: e.target.value })}
                                disabled={savingCoordinatorPrompt} placeholder={t('repoMesh.detail.overridePlaceholder')} />
                            <CoordinatorPromptDefaultPreview
                                daemonId={activeDaemonId}
                                meshId={selectedMesh.id}
                                cliType={coordinatorCliType}
                                sendCommand={sendCommand}
                            />
                        </FormField>
                        <FormField label={t('repoMesh.detail.appendLabel')} hint={t('repoMesh.detail.appendHint')}>
                            <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                                rows={4} value={coordinatorPromptDraft.append}
                                onChange={e => onCoordinatorPromptDraftChange({ ...coordinatorPromptDraft, append: e.target.value })}
                                disabled={savingCoordinatorPrompt} placeholder={t('repoMesh.detail.appendPlaceholder')} />
                        </FormField>
                        <details className="mt-2 text-[12px] text-text-muted">
                            <summary className="cursor-pointer select-none">{t('repoMesh.detail.availablePlaceholders')}</summary>
                            <p className="mt-1 font-mono break-words">
                                {'{{meshName}}, {{repo}}, {{defaultBranch}}, {{cliType}}, {{nodes}}, {{policy}}, {{tools}}, {{workflow}}, {{rules}}, {{toolExposurePreflight}}'}
                            </p>
                        </details>
                        <div className="mt-3 flex items-center gap-2">
                            <button type="button" className="btn btn-primary btn-sm" onClick={onSaveCoordinatorPrompt} disabled={savingCoordinatorPrompt}>
                                {savingCoordinatorPrompt ? t('repoMesh.detail.saving') : t('repoMesh.detail.saveCoordinatorPrompt')}
                            </button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCoordinatorPromptDraftChange({ override: '', append: '' })} disabled={savingCoordinatorPrompt} title={t('repoMesh.detail.clearTitle')}>{t('repoMesh.detail.clear')}</button>
                        </div>
                    </div>

                    {/* User-level (per-machine files on the coordinator daemon) */}
                    <div className="mt-5 border-t border-border-subtle pt-4">
                        <div className="text-[13px] font-semibold mb-1">{t('repoMesh.detail.userLevel')}</div>
                        <p className="text-[12px] text-text-muted mb-3">
                            {t('repoMesh.detail.userLevelDescription')}
                        </p>
                        <CoordinatorPromptsSection daemonId={activeDaemonId || undefined} />
                    </div>
                </Section>
            )}
            </>
            )

            const advancedTabContent = (
            <>
            {/* ── Missions (runtime telemetry) ── */}
            <MeshMissionsSection
                status={displayedMeshStatus}
                daemonId={activeDaemonId}
                meshId={selectedMesh.id}
                sendCommand={sendCommand}
            />

            {/* ── Safety & Git (advanced) ── */}
            <Section title={t('repoMesh.detail.safetyTitle')} collapsible defaultOpen={false}
                badge={<span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">{t('repoMesh.detail.advanced')}</span>}
                description={t('repoMesh.detail.safetyDescription')}>
                <div className="grid gap-4 sm:grid-cols-2">
                    {[
                        { label: t('repoMesh.detail.checkpointBefore'), key: 'requirePreTaskCheckpoint', opts: [['no', 'No'], ['yes', 'Yes']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: t('repoMesh.detail.checkpointAfter'), key: 'requirePostTaskCheckpoint', opts: [['yes', 'Yes'], ['no', 'No']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: t('repoMesh.detail.pushApproval'), key: 'requireApprovalForPush', opts: [['required', t('repoMesh.detail.requireApprovalBeforePush')], ['not_required', t('repoMesh.detail.doNotRequireApproval')]], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: t('repoMesh.detail.destructiveGitApproval'), key: 'requireApprovalForDestructiveGit', opts: [['required', t('repoMesh.detail.requireApproval')], ['not_required', t('repoMesh.detail.doNotRequireApproval')]], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: t('repoMesh.detail.uncommittedChanges'), key: 'dirtyWorkspaceBehavior', opts: [['warn', t('repoMesh.detail.warnAndContinue')], ['block', t('repoMesh.detail.blockTask')], ['checkpoint_then_continue', t('repoMesh.detail.checkpointThenContinue')]], val: (v: any) => v || 'warn', parse: (v: string) => v },
                        { label: t('repoMesh.detail.autoPublishSubmodule'), key: 'allowAutoPublishSubmoduleMainCommits', opts: [['disabled', t('repoMesh.detail.requireExplicitApproval')], ['enabled', t('repoMesh.detail.allowRefineryPublish')]], val: (v: any) => v ? 'enabled' : 'disabled', parse: (v: string) => v === 'enabled' },
                    ].map(({ label, key, opts, val, parse }) => (
                        <FormField key={key} label={label}>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={val(policy[key])} onChange={e => onUpdatePolicy({ [key]: parse(e.target.value) })} disabled={savingPolicy}>
                                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </FormField>
                    ))}
                </div>
                {(() => {
                    // Auto fast-forward is a NESTED policy object (autoFastForward.*), so its
                    // toggles patch the whole sub-object (spread current + the changed field)
                    // rather than a flat policy key. Defaults mirror the daemon normalizer:
                    // enabled=true, remoteNodes=false, mode='idle'.
                    const aff = (policy.autoFastForward && typeof policy.autoFastForward === 'object' ? policy.autoFastForward : {}) as {
                        enabled?: boolean; remoteNodes?: boolean; mode?: string;
                    };
                    const affEnabled = aff.enabled !== false;
                    const affRemote = aff.remoteNodes === true;
                    const affMode = aff.mode === 'continuous' ? 'continuous' : 'idle';
                    const patchAff = (change: Record<string, unknown>) =>
                        onUpdatePolicy({ autoFastForward: { ...aff, ...change } });
                    return (
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            <FormField label={t('repoMesh.detail.autoFastForward')}>
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={affEnabled ? 'enabled' : 'disabled'} onChange={e => patchAff({ enabled: e.target.value === 'enabled' })} disabled={savingPolicy}>
                                    <option value="enabled">{t('repoMesh.detail.ffEnabled')}</option>
                                    <option value="disabled">{t('repoMesh.detail.ffDisabled')}</option>
                                </select>
                            </FormField>
                            <FormField label={t('repoMesh.detail.includeRemoteNodes')} hint={t('repoMesh.detail.includeRemoteNodesHint')}>
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={affRemote ? 'yes' : 'no'} onChange={e => patchAff({ remoteNodes: e.target.value === 'yes' })} disabled={savingPolicy || !affEnabled}>
                                    <option value="no">{t('repoMesh.detail.remoteNo')}</option>
                                    <option value="yes">{t('repoMesh.detail.remoteYes')}</option>
                                </select>
                            </FormField>
                            <FormField label={t('repoMesh.detail.detectionMode')} hint={t('repoMesh.detail.detectionModeHint')}>
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={affMode} onChange={e => patchAff({ mode: e.target.value === 'continuous' ? 'continuous' : 'idle' })} disabled={savingPolicy || !affEnabled || !affRemote}>
                                    <option value="idle">{t('repoMesh.detail.idleEdgeOnly')}</option>
                                    <option value="continuous">{t('repoMesh.detail.continuousScan')}</option>
                                </select>
                            </FormField>
                        </div>
                    );
                })()}
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                    <FormField label={t('repoMesh.detail.sessionCleanupLabel')} hint={t('repoMesh.detail.sessionCleanupHint')}>
                        <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.sessionCleanupOnNodeRemove || 'preserve'} onChange={e => onUpdatePolicy({ sessionCleanupOnNodeRemove: e.target.value })} disabled={savingPolicy}>
                            {SESSION_CLEANUP_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                    </FormField>
                    <div className="mt-2 text-[12px] text-text-muted">
                        {SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove)?.description || SESSION_CLEANUP_MODE_OPTIONS[0].description}
                    </div>
                </div>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">{t('repoMesh.detail.saving')}</div>}
            </Section>
            </>
            )

            const tabs: SettingsTab[] = [
                { key: 'nodes', label: t('repoMesh.detail.tabNodes'), content: nodesTabContent },
                { key: 'scheduling', label: t('repoMesh.detail.tabScheduling'), content: schedulingTabContent },
                { key: 'prompts', label: t('repoMesh.detail.tabPrompts'), content: (
                    <>
                        {promptsTabContent}
                        {/* ── Integrations: Standalone Hermes MCP config ── */}
                        {features.hermesMcpConfig && (
                            <RepoMeshHermesMcpConfig meshId={selectedMesh.id} availableCliAgents={availableCliAgents} />
                        )}
                        {/* ── Integrations: Cloud MCP hint ── */}
                        {features.meshHostDaemonSection && (
                            <AlertBanner variant="info" className="mt-4">
                                <strong>{t('repoMesh.detail.mcpMode')}</strong>{' '}
                                <code className="bg-bg-secondary px-1 rounded text-xs">adhdev mcp --repo-mesh {selectedMesh.id}</code>
                                {' '}{t('repoMesh.detail.mcpDescription')}
                            </AlertBanner>
                        )}
                    </>
                ) },
                { key: 'advanced', label: t('repoMesh.detail.tabAdvanced'), content: advancedTabContent },
            ]

            return (
                <>
                    <SettingsTabs tabs={tabs} ariaLabel={t('repoMesh.detail.tabsAriaLabel')} className="flex flex-col gap-4" />

                    {/* ── Observability dialog (launched from the Observability section) ── */}
                    {graphDialogOpen && canLaunchGraphDialog && (
                        <DashboardMeshGraphDialog
                            activeConv={buildMeshGraphLaunchConversation({ meshId: selectedMesh.id, daemonId: activeDaemonId, meshName: selectedMesh.name })}
                            sendDaemonCommand={sendCommand}
                            onClose={() => setGraphDialogOpen(false)}
                        />
                    )}
                </>
            )
            })()}
        </AppPage>
    )
}
