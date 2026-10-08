import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshStatus, RepoMeshQuotaRoutingPolicy } from '@adhdev/daemon-core'
import AppPage from '../../components/ui/AppPage'
import { Section } from '../../components/ui/Section'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField } from '../../components/ui/FormField'
import { InfoTip } from '../../components/ui/InfoTip'
import { Switch } from '../../components/ui/Switch'
import { SettingsTabs, type SettingsTab } from '../../components/ui/SettingsTabs'
import { IconMesh, IconSettings, IconWrench } from '../../components/Icons'
import { MeshNotesTab } from '../../components/MeshGraph/MeshObservabilitySurface/MeshNotesTab'
import { MeshGraphThemeContext } from '../../components/MeshGraph/MeshObservabilitySurface/meshSurfaceTheme'
import { getMeshGraphTheme } from '../../components/MeshGraph/meshGraphTheme'
import { useTheme } from '../../hooks/useTheme'
import QuotaPolicyStep from '../../components/setup-wizard/QuotaPolicyStep'
import CoordinatorPromptDefaultPreview from './CoordinatorPromptDefaultPreview'
import RepoMeshJsonAppendNotice from './RepoMeshJsonAppendNotice'
// Lazy: the graph dialog (xyflow + elkjs) only loads when it first opens.
import DashboardMeshGraphDialog from '../../components/dashboard/LazyDashboardMeshGraphDialog'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import { collectMeshProviderInventory } from './node-providers'
import { COORDINATOR_PROMPT_PLACEHOLDERS } from './coordinator-prompt-placeholders'
import { MeshProviderAutoApproveSection } from './MeshProviderAutoApproveSection'
import { MeshNodeList } from './MeshNodeList'
import { MeshHostDaemonSection } from './MeshHostDaemonSection'
import { buildMeshGraphLaunchConversation } from './graph-launch'
import {
    readMeshPolicy,
    isMeshPolicyKeySet,
    SESSION_CLEANUP_MODE_OPTIONS,
    DISTRIBUTION_OPTIONS,
    distributionToStrategy,
    strategyToDistribution,
    type MeshEntry,
    type MeshNode,
    type MeshDistribution,
    type MeshQueueEntry,
    type MeshDetailViewFeatures,
    type NodeCapabilitySlot,
} from './types'

interface Props {
    selectedMesh: MeshEntry
    error: string | null
    onDismissError: () => void
    onBack: () => void
    onDelete: (meshId: string) => void

    // Graph / live mesh status (drives the graph dialog launcher)
    displayedMeshStatus: RepoMeshStatus | null
    graphLoading: boolean
    graphError: string | null
    onRefreshGraph: (refresh?: boolean) => void

    // Policy
    savingPolicy: boolean
    onUpdatePolicy: (patch: Record<string, unknown>) => void

    // Coordinator prompt
    coordinatorPromptDraft: { append: string }
    onCoordinatorPromptDraftChange: (draft: { append: string }) => void
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


    features: MeshDetailViewFeatures

    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export function MeshDetailView({
    selectedMesh,
    error,
    onDismissError,
    onBack,
    onDelete,
    displayedMeshStatus,
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
    // A provider inventory the coordinator holds for a node wins over the member
    // daemon's own; the member's is only the fallback for an older coordinator.
    const statusNodes = displayedMeshStatus?.nodes ?? null
    const meshProviderInventory = useMemo(
        () => collectMeshProviderInventory(nodes, daemons, statusNodes),
        [nodes, daemons, statusNodes],
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

    // The live view (overview / tasks / map) is the graph dialog, opened from the
    // header's primary "Open" button. This page is the mesh SETTINGS surface.
    const [graphDialogOpen, setGraphDialogOpen] = useState(false)
    const canLaunchGraphDialog = !!activeDaemonId && !!selectedMesh.id
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const selectCls = 'w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary'
    // quotaRouting editors work on the stored OVERRIDES (not the resolved thresholds),
    // so a save never re-sends every default as an explicit value.
    const storedQuotaRouting = selectedMesh.policy?.quotaRouting
    const quotaRouting = (storedQuotaRouting && typeof storedQuotaRouting === 'object' ? storedQuotaRouting : {}) as RepoMeshQuotaRoutingPolicy
    const quotaBusyFallbackOn = quotaRouting.quotaBusyFallback !== false
    const currentDistribution = strategyToDistribution(policy.schedulingStrategy, { priorityConfigured: anyNodePriorityConfigured })

    // ── General: nodes, distribution, visibility, auto-approve ──────────────
    const generalTabContent = (
        <>
            {/* Cloud: host machine (read-only once pinned) */}
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

            <MeshNodeList
                nodes={nodes}
                statusNodes={statusNodes}
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

            {/* Distribution — one line per option; the full explanation is the ⓘ.
                (Mesh-level "Max parallel tasks" stays hidden: real concurrency lives
                per node / per capability slot.) Saves on select. */}
            <Section title={t('mesh.detail.distribution')}>
                <fieldset className="border-none p-0 m-0">
                    <legend className="sr-only">{t('mesh.detail.distribution')}</legend>
                    <div className="flex flex-col gap-2">
                        {DISTRIBUTION_OPTIONS.map(opt => {
                            const selected = currentDistribution === opt.value
                            return (
                                <label key={opt.value}
                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${selected ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border-subtle bg-bg-secondary/60 hover:border-border-default'}`}>
                                    <input type="radio" name="mesh-distribution" className="accent-[var(--accent-primary)]"
                                        value={opt.value} checked={selected} disabled={savingPolicy}
                                        onChange={() => onUpdatePolicy({ schedulingStrategy: distributionToStrategy(opt.value) })} />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 text-sm text-text-primary">
                                            {t(opt.labelKey)}
                                            {recommendedDistribution === opt.value && (
                                                <span className="rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 text-3xs font-medium text-accent-primary">{t('mesh.detail.recommended')}</span>
                                            )}
                                        </span>
                                        <span className="block truncate text-xs text-text-muted">{t(opt.summaryKey)}</span>
                                    </span>
                                    <InfoTip content={t(opt.descriptionKey)} />
                                </label>
                            )
                        })}
                    </div>
                </fieldset>
            </Section>

            {/* Dashboard visibility of the worker sessions this coordinator spawns. */}
            <Section title={t('mesh.detail.visibilityTitle')} description={t('mesh.detail.visibilityHint')}>
                <select className={selectCls} aria-label={t('mesh.detail.visibilityLabel')}
                    value={policy.spawnedSessionVisibility === 'visible' ? 'visible' : 'hidden'}
                    onChange={e => onUpdatePolicy({ spawnedSessionVisibility: e.target.value === 'visible' ? 'visible' : 'hidden' })}
                    disabled={savingPolicy}>
                    <option value="hidden">{t('mesh.detail.visibilityHidden')}</option>
                    <option value="visible">{t('mesh.detail.visibilityVisible')}</option>
                </select>
            </Section>

            {/* Provider auto-approve defaults: repo default (committed) + this
                machine's authorization + the effective result per provider. */}
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

    // ── Advanced: collapsible groups ────────────────────────────────────────
    // Auto fast-forward is a NESTED policy object (autoFastForward.*), so its
    // toggles patch the whole sub-object. Defaults mirror the daemon normalizer:
    // enabled=true, remoteNodes=false, mode='idle'.
    const aff = (policy.autoFastForward && typeof policy.autoFastForward === 'object' ? policy.autoFastForward : {}) as {
        enabled?: boolean; remoteNodes?: boolean; mode?: string;
    }
    const affEnabled = aff.enabled !== false
    const affRemote = aff.remoteNodes === true
    const affMode = aff.mode === 'continuous' ? 'continuous' : 'idle'
    const patchAff = (change: Record<string, unknown>) => onUpdatePolicy({ autoFastForward: { ...aff, ...change } })
    const cleanupMode = SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove) ?? SESSION_CLEANUP_MODE_OPTIONS[0]
    const cleanupSet = isMeshPolicyKeySet(selectedMesh, 'sessionCleanupOnNodeRemove')

    // Set-vs-default for a policy row. The daemon stores only the keys the owner set;
    // an unset key shows a "Default" badge (its value is the daemon-resolved effective
    // one), a set key offers "Reset to default", which sends `null` for that key.
    const policyKeyState = (key: string) => isMeshPolicyKeySet(selectedMesh, key)
        ? (
            <button type="button" className="mt-1.5 text-2xs text-text-muted underline hover:text-text-primary disabled:opacity-50"
                disabled={savingPolicy} onClick={() => onUpdatePolicy({ [key]: null })}>
                {t('mesh.detail.policyResetToDefault')}
            </button>
        )
        : (
            <span className="mt-1.5 inline-block rounded border border-border-subtle px-1.5 py-0.5 text-2xs uppercase tracking-wider text-text-muted">
                {t('mesh.detail.policyDefaultBadge')}
            </span>
        )

    const advancedTabContent = (
        <>
            {/* Quota-aware routing — thresholds AND the busy fallback in one group.
                quotaRouting is ONE nested policy object; both editors patch it with
                the other's current value preserved (the threshold form used to
                replace the object and silently drop quotaBusyFallback). */}
            <Section title={t('setupWizard.quotaPolicy.title')} description={t('setupWizard.quotaPolicy.description')} collapsible defaultOpen={false}>
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-1 text-sm text-text-primary">
                        <span id="mesh-quota-busy-fallback-label">{t('mesh.detail.quotaBusyFallback')}</span>
                        <InfoTip content={t('mesh.detail.quotaBusyFallbackHint')} />
                    </span>
                    <Switch
                        checked={quotaBusyFallbackOn}
                        disabled={savingPolicy}
                        aria-labelledby="mesh-quota-busy-fallback-label"
                        onChange={next => onUpdatePolicy({ quotaRouting: { ...quotaRouting, quotaBusyFallback: next } })}
                    />
                </div>
                <QuotaPolicyStep
                    quotaRouting={(storedQuotaRouting as RepoMeshQuotaRoutingPolicy | undefined) ?? null}
                    saving={savingPolicy}
                    error={error}
                    hideHeader
                    onSave={overrides => onUpdatePolicy({
                        quotaRouting: {
                            ...overrides,
                            ...(quotaRouting.quotaBusyFallback !== undefined ? { quotaBusyFallback: quotaRouting.quotaBusyFallback } : {}),
                        },
                    })}
                />
            </Section>

            {/* Safety & Git — every field saves on change. */}
            <Section title={t('mesh.detail.safetyTitle')} collapsible defaultOpen={false} description={t('mesh.detail.safetyDescription')}>
                <div className="grid gap-4 sm:grid-cols-2">
                    {[
                        { label: t('mesh.detail.pushApproval'), key: 'requireApprovalForPush', opts: [['required', t('mesh.detail.requireApprovalBeforePush')], ['not_required', t('mesh.detail.doNotRequireApproval')]], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: t('mesh.detail.autoPublishSubmodule'), key: 'allowAutoPublishSubmoduleMainCommits', opts: [['disabled', t('mesh.detail.requireExplicitApproval')], ['enabled', t('mesh.detail.allowRefineryPublish')]], val: (v: any) => v ? 'enabled' : 'disabled', parse: (v: string) => v === 'enabled' },
                    ].map(({ label, key, opts, val, parse }) => (
                        <FormField key={key} label={label}>
                            <select className={selectCls}
                                value={val(policy[key])} onChange={e => onUpdatePolicy({ [key]: parse(e.target.value) })} disabled={savingPolicy}>
                                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                            {policyKeyState(key)}
                        </FormField>
                    ))}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <FormField label={t('mesh.detail.autoFastForward')}>
                        <select className={selectCls}
                            value={affEnabled ? 'enabled' : 'disabled'} onChange={e => patchAff({ enabled: e.target.value === 'enabled' })} disabled={savingPolicy}>
                            <option value="enabled">{t('mesh.detail.ffEnabled')}</option>
                            <option value="disabled">{t('mesh.detail.ffDisabled')}</option>
                        </select>
                        {policyKeyState('autoFastForward')}
                    </FormField>
                    <FormField label={t('mesh.detail.includeRemoteNodes')} hint={t('mesh.detail.includeRemoteNodesHint')}>
                        <select className={selectCls}
                            value={affRemote ? 'yes' : 'no'} onChange={e => patchAff({ remoteNodes: e.target.value === 'yes' })} disabled={savingPolicy || !affEnabled}>
                            <option value="no">{t('mesh.detail.remoteNo')}</option>
                            <option value="yes">{t('mesh.detail.remoteYes')}</option>
                        </select>
                    </FormField>
                    <FormField label={t('mesh.detail.detectionMode')} hint={t('mesh.detail.detectionModeHint')}>
                        <select className={selectCls}
                            value={affMode} onChange={e => patchAff({ mode: e.target.value === 'continuous' ? 'continuous' : 'idle' })} disabled={savingPolicy || !affEnabled || !affRemote}>
                            <option value="idle">{t('mesh.detail.idleEdgeOnly')}</option>
                            <option value="continuous">{t('mesh.detail.continuousScan')}</option>
                        </select>
                    </FormField>
                    <FormField label={t('mesh.detail.sessionCleanupLabel')} hint={`${t('mesh.detail.sessionCleanupHint')}\n${cleanupSet ? t(cleanupMode.descriptionKey) : t('mesh.detail.sessionCleanupByNodeTypeHint')}`}>
                        {/* Unset has no single value: the daemon picks per node type
                            (worktree: stop and delete, base: preserve). */}
                        <select className={selectCls}
                            value={cleanupSet ? policy.sessionCleanupOnNodeRemove : ''} onChange={e => onUpdatePolicy({ sessionCleanupOnNodeRemove: e.target.value || null })} disabled={savingPolicy}>
                            {!cleanupSet && <option value="">{t('mesh.detail.sessionCleanupByNodeType')}</option>}
                            {SESSION_CLEANUP_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                        </select>
                        {policyKeyState('sessionCleanupOnNodeRemove')}
                    </FormField>
                </div>
            </Section>

            {/* Coordinator prompt — the mesh-level append, stored in this mesh's
                coordinator config (systemPromptAppend) via update_mesh, with an
                explicit Save. The default base prompt is rendered read-only above
                it. The full-replacement Override field was removed on 2026-10-08
                together with the daemon's override layers. */}
            {features.coordinatorPrompt && (
                <Section title={t('mesh.detail.coordinatorPromptTitle')} collapsible defaultOpen={false}
                    description={t('mesh.detail.thisMeshHint', { name: selectedMesh.name })}>
                    <CoordinatorPromptDefaultPreview
                        daemonId={activeDaemonId}
                        meshId={selectedMesh.id}
                        cliType={coordinatorCliType}
                        sendCommand={sendCommand}
                        defaultOpen
                    />

                    <FormField label={t('mesh.detail.appendLabel')} hint={t('mesh.detail.appendHint')} className="mt-3">
                        <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                            rows={4} value={coordinatorPromptDraft.append}
                            onChange={e => onCoordinatorPromptDraftChange({ ...coordinatorPromptDraft, append: e.target.value })}
                            disabled={savingCoordinatorPrompt} placeholder={t('mesh.detail.appendPlaceholder')} />
                    </FormField>

                    {/* Repo-committed prompt layer (.adhdev/mesh.json) — the field
                        above is MACHINE-LOCAL; a repo may ALSO declare coordinator prompt
                        text that the launch path stacks in. Read-only on purpose. Renders
                        nothing when the repo declares no prompt. */}
                    <RepoMeshJsonAppendNotice
                        daemonId={coordinatorDaemonId}
                        workspace={selectedHostNode?.workspace || ''}
                        sendCommand={sendCommand}
                    />

                    <details className="mt-2 text-xs text-text-muted">
                        <summary className="cursor-pointer select-none inline-flex items-center gap-1">
                            {t('mesh.detail.availablePlaceholders')}
                            <InfoTip content={t('mesh.detail.placeholdersIntro')} size={12} />
                        </summary>
                        <div className="mt-2 overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <tbody>
                                    {COORDINATOR_PROMPT_PLACEHOLDERS.map(p => (
                                        <tr key={p.token} className="border-t border-border-subtle/60 align-top">
                                            <td className="py-1 pr-3 font-mono whitespace-nowrap text-text-secondary">{`{{${p.token}}}`}</td>
                                            <td className="py-1 pr-3">{p.description}</td>
                                            <td className="py-1 font-mono text-text-muted/80">{p.example}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                    {/* Save bar — text areas only. */}
                    <div className="mt-3 flex items-center gap-2">
                        <button type="button" className="btn btn-primary btn-sm" onClick={onSaveCoordinatorPrompt} disabled={savingCoordinatorPrompt}>
                            {savingCoordinatorPrompt ? t('mesh.detail.saving') : t('mesh.detail.saveCoordinatorPrompt')}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCoordinatorPromptDraftChange({ append: '' })} disabled={savingCoordinatorPrompt} title={t('mesh.detail.clearTitle')}>{t('mesh.detail.clear')}</button>
                    </div>
                </Section>
            )}

            {/* Coordinator notes — manual CRUD of the coordinator's operating notes
                (was a tab in the graph dialog; it is configuration, so it lives here). */}
            <Section title={t('mesh.notes.tab')} collapsible defaultOpen={false} description={t('mesh.notes.sectionHint')}>
                <MeshGraphThemeContext.Provider value={meshTheme}>
                    <MeshNotesTab meshId={selectedMesh.id} daemonId={activeDaemonId} sendDaemonCommand={sendCommand} />
                </MeshGraphThemeContext.Provider>
            </Section>

            {/* Integrations */}
            {features.meshHostDaemonSection && (
                <Section title={t('mesh.detail.useFromCli')} collapsible defaultOpen={false} description={t('mesh.detail.mcpDescription')}>
                    <code className="block overflow-x-auto rounded-lg bg-bg-secondary px-3 py-2 text-xs">adhdev mcp --repo-mesh {selectedMesh.id}</code>
                </Section>
            )}
        </>
    )

    const tabs: SettingsTab[] = [
        { key: 'general', icon: <IconSettings size={14} />, label: t('mesh.detail.tabGeneral'), content: generalTabContent },
        { key: 'advanced', icon: <IconWrench size={14} />, label: t('mesh.detail.tabAdvanced'), content: advancedTabContent },
    ]

    return (
        <AppPage
            icon={<IconMesh />}
            title={selectedMesh.name}
            subtitle={selectedMesh.repoIdentity || (selectedMesh as any).repo_identity || 'Repo Mesh'}
            subtitleInline
            widthClassName="max-w-5xl"
            contentClassName="gap-4"
            actions={
                <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={onBack}>{t('mesh.detail.back')}</button>
                    <button
                        type="button"
                        className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
                        onClick={() => setGraphDialogOpen(true)}
                        disabled={!canLaunchGraphDialog}
                        title={canLaunchGraphDialog ? t('mesh.detail.observabilityOpenTitle') : t('mesh.detail.observabilityDisabledTitle')}
                    >
                        <IconMesh size={14} />{t('mesh.detail.observabilityOpen')}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => onDelete(selectedMesh.id)}>{t('mesh.detail.delete')}</button>
                </div>
            }
        >
            {error && <AlertBanner variant="error" onDismiss={onDismissError}>{error}</AlertBanner>}
            {graphError && <AlertBanner variant="warning">{graphError}</AlertBanner>}

            {/* Same frame as the account page: underline tabs with icons flush
                against the top of one card. */}
            <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card/30">
                <SettingsTabs
                    variant="underline"
                    tabs={tabs}
                    tabIdPrefix="mesh-settings-tab"
                    ariaLabel={t('mesh.detail.tabsAriaLabel')}
                    panelClassName="p-4 md:p-6"
                />
            </div>

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
