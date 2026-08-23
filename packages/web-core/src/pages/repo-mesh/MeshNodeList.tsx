import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deriveProviderPriorityFromSlots } from '@adhdev/mesh-shared'

import { Section } from '../../components/ui/Section'
import { EmptyState } from '../../components/ui/EmptyState'
import { AlertBanner } from '../../components/ui/AlertBanner'
import { FormField, Input } from '../../components/ui/FormField'
import { IconX, IconFolder } from '../../components/Icons'
import ProviderPriorityEditor from '../../components/provider-priority/ProviderPriorityEditor'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import { IconPlus } from './icons'
import { buildProvidersByDaemonId } from './node-providers'
import { shortMachineKey } from '../../components/MeshGraph/MeshObservabilitySurface/meshSurfaceHelpers'
import { MeshMachineNodeGroup } from './MeshMachineNodeGroup'
import type { MeshNode, MeshNodeListFeatures, MeshQueueEntry, NodeCapabilitySlot } from './types'

export function getNodeActiveAssignments(node: MeshNode, queue: MeshQueueEntry[]): MeshQueueEntry[] {
    return queue.filter(task => {
        if (task.status !== 'assigned') return false
        return (task.assignedNodeId || task.nodeId) === node.id
    })
}

export function describeNodeActiveAssignmentLabel(task: MeshQueueEntry): string {
    const sessionId = task.assignedSessionId || task.sessionId || 'unassigned session'
    const message = task.message.length > 80 ? `${task.message.slice(0, 77)}…` : task.message
    return `${sessionId}: ${message}`
}

function readNodeProviderPriority(node: MeshNode): string[] {
    const raw = Array.isArray(node.providerPriority)
        ? node.providerPriority
        : Array.isArray(node.policy?.providerPriority)
            ? node.policy.providerPriority
            : []
    const seen = new Set<string>()
    const explicit = raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => { if (seen.has(type)) return false; seen.add(type); return true })
    if (explicit.length) return explicit
    // Slots order = preference: derive the priority from capability slots when no
    // explicit providerPriority is set (same fallback as the daemon read paths).
    return deriveProviderPriorityFromSlots(node.policy?.slots)
}

export function describeNodeProviderPriority(node: MeshNode): { configured: boolean; label: string; launchBlockedMessage?: string } {
    const pp = readNodeProviderPriority(node)
    if (!pp.length) return { configured: false, label: 'not configured', launchBlockedMessage: 'No provider configured on this node — task launch is blocked until a capability slot or provider priority is set.' }
    return { configured: true, label: pp.join(' → ') }
}

export function isWorktreeNode(node: { isLocalWorktree?: boolean }): boolean {
    return node.isLocalWorktree === true
}

export function daemonLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    // Never fall back to the raw full-length daemon.id as the TITLE — the id
    // is still shown as the subtitle below (short, monospace) for disambiguation,
    // but a hash reading as the primary name looks like broken UI. shortMachineKey
    // mirrors resolveMachineLabel's identical last-resort truncation.
    return daemon.machineNickname || daemon.nickname || daemon.hostname || (daemon.id ? shortMachineKey(daemon.id) : undefined) || 'Unknown'
}

/** Group key for a node's owning machine. Cloud nodes carry `daemon_id`/`daemonId`;
 *  standalone nodes carry neither (single local daemon, no per-node binding) — those
 *  fall into the '' bucket, which the caller treats as "ungrouped" (no tabs). */
function nodeMachineKey(node: MeshNode): string {
    return String((node as any).daemon_id || (node as any).daemonId || '')
}

interface MachineGroup {
    key: string
    label: string
    online: boolean
    nodes: MeshNode[]
    slotCount: number
}

/** Group nodes by owning machine (daemon_id), in first-seen order. Nodes with no
 *  machine binding (standalone) collapse into a single '' group. */
function groupNodesByMachine(nodes: MeshNode[], daemons: RepoMeshDaemonEntry[]): MachineGroup[] {
    const daemonsById = new Map(daemons.map(d => [d.id, d]))
    const order: string[] = []
    const byKey = new Map<string, MeshNode[]>()
    for (const node of nodes) {
        const key = nodeMachineKey(node)
        if (!byKey.has(key)) { byKey.set(key, []); order.push(key) }
        byKey.get(key)!.push(node)
    }
    return order.map(key => {
        const groupNodes = byKey.get(key)!
        const daemon = key ? daemonsById.get(key) : undefined
        const firstNode = groupNodes[0] as any
        const label = key
            ? (daemon ? daemonLabel(daemon) : (firstNode?.machine_label || firstNode?.machine_nickname || firstNode?.hostname || key))
            : daemonLabel(daemon)
        const online = daemon?.status === 'online'
        const slotCount = groupNodes.reduce((sum, n) => sum + (Array.isArray(n.policy?.slots) ? n.policy!.slots!.length : 0), 0)
        return { key, label, online, nodes: groupNodes, slotCount }
    })
}

function MachineTabBar({ groups, activeKey, onChange }: { groups: MachineGroup[]; activeKey: string; onChange: (key: string) => void }) {
    const { t } = useTranslation('common')
    return (
        <div className="flex items-center gap-1 px-1 border-b border-border-subtle mb-4 overflow-x-auto" role="tablist" aria-label={t('repoMesh.nodeList.machineTabsLabel')}>
            {groups.map(group => {
                const isActive = group.key === activeKey
                return (
                    <button
                        key={group.key}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => onChange(group.key)}
                        className={`flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer whitespace-nowrap ${
                            isActive
                                ? 'border-accent text-accent'
                                : 'border-transparent text-text-muted hover:text-text-secondary'
                        }`}
                    >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${group.online ? 'bg-green-400' : 'bg-neutral-500'}`} />
                        <span className="truncate max-w-[160px]">{group.label}</span>
                        <span className="text-[11px] text-text-muted font-normal">
                            {t('repoMesh.nodeList.machineTabCounts', { nodes: group.nodes.length, slots: group.slotCount })}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

interface Props {
    nodes: MeshNode[]
    meshQueue: MeshQueueEntry[]
    activeDaemon: RepoMeshDaemonEntry | undefined
    daemons: RepoMeshDaemonEntry[]
    selectedMeshId: string
    userName?: string
    features: MeshNodeListFeatures
    coordinatorDaemonId: string

    availableCliProviders: AvailableCliProviderOption[]

    // Capability slots (ORCHESTRATION_NODE_SLOTS.md)
    savingNodeSlotsId: string | null
    onUpdateNodeSlots: (node: MeshNode, slots: NodeCapabilitySlot[]) => void

    // Custom capability (routing) tags
    savingNodeCapabilitiesId: string | null
    onUpdateNodeCapabilities: (node: MeshNode, capabilities: string[]) => void

    // Node instruction
    nodeSystemPromptDrafts: Record<string, string>
    onNodeSystemPromptDraftChange: (nodeId: string, value: string) => void
    savingNodeSystemPromptId: string | null
    onSaveNodeSystemPrompt: (node: MeshNode) => void

    // Selection
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void

    // Add node form
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
}

export function MeshNodeList({
    nodes,
    meshQueue,
    activeDaemon,
    daemons,
    selectedMeshId,
    userName,
    features,
    coordinatorDaemonId,
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
}: Props) {
    const { t } = useTranslation('common')
    // Per-daemon detected CLI providers, so each existing node's "DEFAULT CLI PROVIDERS"
    // list reflects its own daemon rather than the mesh's first daemon (daemons[0]).
    const providersByDaemonId = useMemo(() => buildProvidersByDaemonId(daemons), [daemons])

    // Worktree nodes are ephemeral runtime artifacts, not static mesh configuration —
    // they are excluded from this settings list entirely. A read-only runtime view of
    // worktrees, if needed, belongs on the Observability/Status surface, not here.
    const machineNodes = useMemo(() => nodes.filter(n => !isWorktreeNode(n)), [nodes])

    // Per-machine tabs (cloud only — standalone nodes carry no daemon_id, so they
    // collapse into a single group and never show a tab bar). With one machine or
    // fewer, a tab bar is pure noise, so it is only rendered for 2+ groups.
    const machineGroups = useMemo(
        () => features.addNodeDaemonPicker ? groupNodesByMachine(machineNodes, daemons) : [],
        [features.addNodeDaemonPicker, machineNodes, daemons],
    )
    const [activeMachineKey, setActiveMachineKey] = useState<string | null>(null)
    const resolvedActiveMachineKey = machineGroups.some(g => g.key === activeMachineKey)
        ? activeMachineKey!
        : (machineGroups[0]?.key ?? '')

    return (
        <Section
            title={features.addNodeDaemonPicker ? t('repoMesh.nodeList.title', { count: machineNodes.length }) : t('repoMesh.nodeList.titleNoCount')}
            description={features.addNodeDaemonPicker
                ? t('repoMesh.nodeList.descriptionCloud')
                : t('repoMesh.nodeList.descriptionStandalone')}
        >
            {/* Cloud: daemon candidate picker */}
            {features.addNodeDaemonPicker && (
                <div className="mb-4 rounded-xl border border-border-subtle bg-bg-secondary/60 p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div className="min-w-0">
                            <div className="text-sm font-semibold text-text-primary">{t('repoMesh.nodeList.daemonCandidates')}</div>
                            <div className="text-xs text-text-muted">{t('repoMesh.nodeList.daemonCandidatesHint')}</div>
                        </div>
                        <span className="text-[11px] text-text-muted shrink-0">{t('repoMesh.nodeList.available', { count: attachableDaemons.length })}</span>
                    </div>
                    {daemons.length === 0 ? (
                        <div className="text-xs text-text-muted">{t('repoMesh.nodeList.noDaemonsAvailable')}</div>
                    ) : attachableDaemons.length === 0 ? (
                        <div className="text-xs text-text-muted">{t('repoMesh.nodeList.allDaemonsAttached')}</div>
                    ) : (
                        <div className="grid gap-2 md:grid-cols-2">
                            {attachableDaemons.map(d => (
                                <button key={d.id} type="button"
                                    // min-w-0: a grid item's default `min-width:auto` floors the track at
                                    // the widest content, so the long monospace daemon id below pushes the
                                    // card past the viewport (and defeats its own `truncate`) on mobile.
                                    className={`text-left rounded-lg border px-3 py-2 transition-colors min-w-0 ${d.id === coordinatorDaemonId ? 'border-accent-primary/50 bg-accent-primary/10' : 'border-border-subtle bg-bg-primary hover:border-border-default'}`}
                                    onClick={() => {
                                        onNodeDaemonIdChange(d.id)
                                        onNodeWorkspaceChange('')
                                        onNodeCustomPathChange(false)
                                        onNodeProviderPriorityChange(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((d as any).availableProviders || [])))
                                        onShowAddNode()
                                    }}>
                                    <div className="flex items-center justify-between gap-2">
                                        {/* min-w-0 on the truncating child; shrink-0 on the badge so the
                                            label yields first instead of the badge wrapping. */}
                                        <span className="text-sm font-medium truncate min-w-0">{daemonLabel(d)}</span>
                                        {d.id === coordinatorDaemonId && <span className="text-[10px] text-accent-primary shrink-0">{t('repoMesh.nodeList.selectedHost')}</span>}
                                    </div>
                                    <div className="mt-1 text-[11px] text-text-muted font-mono truncate">{d.id}</div>
                                    <div className="mt-1 text-[11px] text-text-muted">{t('repoMesh.nodeList.workspacesDetected', { count: (d.workspaces || []).length })}</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Add node button */}
            {!showAddNode && (
                <button className="btn btn-primary btn-sm mb-4 inline-flex items-center gap-1.5" onClick={onShowAddNode}>
                    <IconPlus size={13} /> {features.addNodeDaemonPicker ? t('repoMesh.nodeList.attachMachine') : t('repoMesh.nodeList.addNode')}
                </button>
            )}

            {/* Add node form */}
            {showAddNode && (
                <div className="mb-4 p-4 rounded-xl border border-accent-primary/30 bg-bg-glass animate-[fadeIn_0.3s_ease-out]">
                    <div className="flex justify-between items-center mb-3">
                        <h4 className="text-sm font-bold">{features.addNodeDaemonPicker ? t('repoMesh.nodeList.attachMachineTitle') : t('repoMesh.nodeList.addNodeTitle')}</h4>
                        <button onClick={() => { onCancelAddNode(); onNodeDaemonIdChange(''); onNodeCustomPathChange(false) }} className="text-text-muted cursor-pointer bg-transparent border-none"><IconX size={16} /></button>
                    </div>

                    {/* Cloud: machine picker */}
                    {features.addNodeDaemonPicker && (
                        <FormField label={t('repoMesh.nodeList.machine')}>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={nodeDaemonId} onChange={e => {
                                    onNodeDaemonIdChange(e.target.value)
                                    onNodeWorkspaceChange('')
                                    onNodeCustomPathChange(false)
                                    onNodeProviderPriorityChange(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((daemons.find(d => d.id === e.target.value) as any)?.availableProviders || [])))
                                }}>
                                <option value="">{t('repoMesh.nodeList.selectMachine')}</option>
                                {daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
                            </select>
                        </FormField>
                    )}

                    {/* Workspace picker */}
                    {(features.addNodeDaemonPicker ? nodeDaemonId : true) && (
                        <FormField label={t('repoMesh.nodeList.workspacePath')}>
                            {features.addNodeDaemonPicker && !nodeCustomPath && nodePickerWorkspaces.length > 0 ? (
                                <>
                                    <div className="flex flex-col gap-1.5 mb-2">
                                        {nodePickerWorkspaces.map(w => (
                                            <button key={w.id || w.path} type="button"
                                                className={`text-left text-xs px-3 py-2 rounded-lg border transition-colors ${nodeWorkspace === w.path ? 'border-accent-primary bg-accent-primary/10 text-text-primary' : 'border-border-subtle bg-bg-primary hover:bg-violet-500/10 text-text-primary'}`}
                                                onClick={() => onNodeWorkspaceChange(w.path)}>
                                                <span className="font-medium block truncate">{w.label || w.path.split('/').pop()}</span>
                                                <span className="text-[10px] text-text-muted font-mono truncate block">{w.path}</span>
                                            </button>
                                        ))}
                                    </div>
                                    <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0" onClick={() => { onNodeCustomPathChange(true); onNodeWorkspaceChange('') }}>{t('repoMesh.nodeList.enterCustomPath')}</button>
                                </>
                            ) : (
                                <>
                                    {!features.addNodeDaemonPicker ? (
                                        (() => {
                                            const knownWorkspaces: Array<{ id?: string; path: string; label?: string | null }> = Array.isArray((activeDaemon as any)?.workspaces) ? (activeDaemon as any).workspaces : []
                                            const datalistId = `mesh-add-node-workspaces-${selectedMeshId || 'new'}`
                                            return (
                                                <>
                                                    <Input value={nodeWorkspace} onChange={e => onNodeWorkspaceChange(e.target.value)} placeholder={knownWorkspaces[0]?.path || '/Users/dev/projects/myapp'}
                                                        list={knownWorkspaces.length > 0 ? datalistId : undefined} autoFocus />
                                                    {knownWorkspaces.length > 0 && (
                                                        <>
                                                            <datalist id={datalistId}>{knownWorkspaces.map(w => <option key={w.id || w.path} value={w.path}>{w.label || w.path}</option>)}</datalist>
                                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                                {knownWorkspaces.slice(0, 6).map(w => (
                                                                    <button key={w.id || w.path} type="button" onClick={() => onNodeWorkspaceChange(w.path)}
                                                                        className="text-[11px] px-2 py-0.5 rounded-full border border-border-subtle hover:border-accent-primary/50 text-text-muted hover:text-text-primary transition-colors bg-transparent cursor-pointer" title={w.path}>
                                                                        {w.label || w.path.split('/').filter(Boolean).pop() || w.path}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </>
                                                    )}
                                                </>
                                            )
                                        })()
                                    ) : (
                                        <>
                                            <Input value={nodeWorkspace} onChange={e => onNodeWorkspaceChange(e.target.value)} placeholder="/Users/dev/projects/myapp" onKeyDown={e => { if (e.key === 'Enter') onAddNode() }} />
                                            {nodePickerWorkspaces.length > 0 && (
                                                <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0 mt-1" onClick={() => { onNodeCustomPathChange(false); onNodeWorkspaceChange('') }}>{t('repoMesh.nodeList.pickFromSaved')}</button>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </FormField>
                    )}

                    {(nodePlanLoading || nodeOnboardingPlan) && (
                        <AlertBanner
                            variant={nodeOnboardingPlan?.success === false ? 'error' : 'info'}
                            className="mb-4"
                        >
                            {nodePlanLoading
                                ? 'Inspecting Git repository (read-only)…'
                                : nodeOnboardingPlan?.success
                                    ? `${nodeOnboardingPlan.plan?.summary || 'Compatible Git workspace detected.'} Adding remains an explicit action.`
                                    : `${nodeOnboardingPlan?.code || 'onboarding_blocked'}: ${nodeOnboardingPlan?.error || 'Git discovery failed'} ${nodeOnboardingPlan?.action || ''}`}
                        </AlertBanner>
                    )}

                    <FormField label={t('repoMesh.nodeList.preferredTools')} hint={t('repoMesh.nodeList.preferredToolsHint')}>
                        <ProviderPriorityEditor
                            value={nodeProviderPriority}
                            availableProviders={features.addNodeDaemonPicker ? nodePickerProviders : availableCliProviders}
                            onChange={onNodeProviderPriorityChange}
                        />
                    </FormField>

                    <div className="flex gap-2 mt-3">
                        <button onClick={onAddNode} disabled={nodePlanLoading || nodeOnboardingPlan?.success === false || !nodeWorkspace.trim() || (features.addNodeDaemonPicker && !nodeDaemonId)} className="btn btn-primary btn-sm">{t('repoMesh.nodeList.add')}</button>
                        <button onClick={() => { onCancelAddNode(); onNodeDaemonIdChange(''); onNodeCustomPathChange(false) }} className="btn btn-secondary btn-sm">{t('repoMesh.nodeList.cancel')}</button>
                    </div>
                </div>
            )}

            {machineNodes.length === 0 ? (
                <EmptyState icon={<IconFolder />} title={t('repoMesh.nodeList.emptyTitle')} description={t('repoMesh.nodeList.emptyDescription')} />
            ) : features.addNodeDaemonPicker ? (
                <>
                    {/* Per-machine tabs — one tab per daemon_id, hidden entirely when
                        there is only one machine (a single-tab bar is pure noise). */}
                    {machineGroups.length > 1 && (
                        <MachineTabBar groups={machineGroups} activeKey={resolvedActiveMachineKey} onChange={setActiveMachineKey} />
                    )}
                    <MeshMachineNodeGroup
                        nodes={machineGroups.find(g => g.key === resolvedActiveMachineKey)?.nodes || machineNodes}
                        meshQueue={meshQueue}
                        activeDaemon={activeDaemon}
                        daemons={daemons}
                        userName={userName}
                        features={features}
                        providersByDaemonId={providersByDaemonId}
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
                        onRemoveNode={onRemoveNode}
                    />
                </>
            ) : (
                // Standalone: nodes carry no daemon_id (single local daemon), so there is
                // nothing to group by — render the flat list exactly as before.
                <MeshMachineNodeGroup
                    nodes={machineNodes}
                    meshQueue={meshQueue}
                    activeDaemon={activeDaemon}
                    daemons={daemons}
                    userName={userName}
                    features={features}
                    providersByDaemonId={providersByDaemonId}
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
                    onRemoveNode={onRemoveNode}
                />
            )}
        </Section>
    )
}
