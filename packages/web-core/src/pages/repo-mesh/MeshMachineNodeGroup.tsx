import { useTranslation } from 'react-i18next'

import { EmptyState } from '../../components/ui/EmptyState'
import { FormField } from '../../components/ui/FormField'
import { IconFolder } from '../../components/Icons'
import NodeSlotEditor from './NodeSlotEditor'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import { IconTrash, NodeHealthBadge } from './icons'
import { resolveNodeAvailableProviders } from './node-providers'
import NodeTagEditor from './NodeTagEditor'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import {
    getNodeActiveAssignments,
    describeNodeActiveAssignmentLabel,
    describeNodeProviderPriority,
} from './MeshNodeList'
import type { MeshNode, MeshNodeListFeatures, MeshQueueEntry } from './types'

function getNodeActiveSessions(node: MeshNode, daemon: RepoMeshDaemonEntry | undefined): Array<{ id: string; provider: string; status: string }> {
    const d = daemon as any
    const buckets = [
        ...(Array.isArray(d?.cliSessions) ? d.cliSessions : []),
        ...(Array.isArray(d?.acpSessions) ? d.acpSessions : []),
        ...(Array.isArray(d?.sessions) ? d.sessions : []),
    ]
    return buckets
        .filter((s: any) => s?.settings?.meshNodeId === node.id || s?.workspace === node.workspace)
        .map((s: any) => ({
            id: s.sessionId || s.id || s.instanceId || 'unknown',
            provider: s.providerType || s.cliType || s.acpType || s.type || 'unknown',
            status: s.status || s.activeChat?.status || 'unknown',
        }))
}

function daemonOwnerLabel(daemon: RepoMeshDaemonEntry | undefined, fallback?: string): string {
    return (daemon as any)?.ownerName || (daemon as any)?.userName || (daemon as any)?.user?.name || fallback || 'You'
}

interface Props {
    nodes: MeshNode[]
    meshQueue: MeshQueueEntry[]
    activeDaemon: RepoMeshDaemonEntry | undefined
    daemons: RepoMeshDaemonEntry[]
    userName?: string
    features: MeshNodeListFeatures

    providersByDaemonId: Map<string, AvailableCliProviderOption[]>

    savingNodeSlotsId: string | null
    onUpdateNodeSlots: (node: MeshNode, slots: any[]) => void
    savingNodeCapabilitiesId: string | null
    onUpdateNodeCapabilities: (node: MeshNode, capabilities: string[]) => void

    nodeSystemPromptDrafts: Record<string, string>
    onNodeSystemPromptDraftChange: (nodeId: string, value: string) => void
    savingNodeSystemPromptId: string | null
    onSaveNodeSystemPrompt: (node: MeshNode) => void

    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void

    onRemoveNode: (nodeId: string) => void
}

/**
 * Renders the node cards for ONE machine's worth of nodes. Extracted out of
 * MeshNodeList so the per-machine tab bar there can mount exactly one group at a
 * time instead of the whole mesh's nodes stacked vertically. All per-node
 * behavior (slots, tags, instruction, remove, diagnostics) is unchanged —
 * this is the same JSX that used to live inline in MeshNodeList.
 */
export function MeshMachineNodeGroup({
    nodes,
    meshQueue,
    activeDaemon,
    daemons,
    userName,
    features,
    providersByDaemonId,
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
    onRemoveNode,
}: Props) {
    const { t } = useTranslation('common')

    if (nodes.length === 0) {
        return <EmptyState icon={<IconFolder />} title={t('repoMesh.nodeList.emptyTitle')} description={t('repoMesh.nodeList.emptyDescription')} />
    }

    return (
        <div className="flex flex-col gap-2">
            {nodes.map(node => {
                const priorityStatus = describeNodeProviderPriority(node)
                const activeAssignments = getNodeActiveAssignments(node, meshQueue)
                const activeSessions = getNodeActiveSessions(node, activeDaemon)
                const isSelected = selectedNodeId === node.id
                const health = (node as any).status || (node as any).machine_status || (activeAssignments.length > 0 || activeSessions.length > 0 ? 'active' : 'enabled')

                return (
                    <div key={node.id}
                        className={`p-3 rounded-lg border bg-bg-primary transition-colors ${features.addNodeDaemonPicker ? 'bg-bg-glass border-border-subtle rounded-xl px-5 py-4' : `cursor-pointer ${isSelected ? 'border-accent-primary/60' : 'border-border-subtle hover:border-accent-primary/35'}`}`}
                        role={!features.addNodeDaemonPicker ? 'button' : undefined}
                        tabIndex={!features.addNodeDaemonPicker ? 0 : undefined}
                        onClick={!features.addNodeDaemonPicker ? () => onSelectNode(isSelected ? null : node.id) : undefined}
                        onKeyDown={!features.addNodeDaemonPicker ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(isSelected ? null : node.id) } } : undefined}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    {features.addNodeDaemonPicker
                                        ? <span className="font-semibold text-sm text-text-primary truncate">{(node as any).machine_label || (node as any).machine_nickname || (node as any).hostname || node.workspace}</span>
                                        : <span className="text-sm font-medium">{node.workspace.split('/').pop()}</span>
                                    }
                                    {features.addNodeDaemonPicker && <NodeHealthBadge status={health} />}
                                    {/* Worktree (ephemeral runtime) nodes are filtered out of this settings
                                        list — only static machine nodes appear here. Live per-node runtime
                                        (active task count, sessions, git drift) lives on the Mesh "Status"
                                        tab. See MeshObservabilitySurface → MeshStatusTab. */}
                                    {features.addNodeDaemonPicker && <span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">{t('repoMesh.nodeList.setupInventory')}</span>}
                                </div>

                                {features.addNodeDaemonPicker && (
                                    <div className="text-[11px] text-text-muted">
                                        {t('repoMesh.nodeList.ownerMachine', {
                                            owner: daemonOwnerLabel(daemons.find(d => d.id === String((node as any).daemon_id || '')), userName),
                                            machine: (node as any).machine_label || (node as any).daemon_id || node.workspace,
                                        })}
                                    </div>
                                )}

                                <div className="text-[10px] text-text-muted font-mono">{node.workspace}</div>

                                {/* Routing tags — what a task's required_tags can target on this node.
                                    Auto-derived tags are read-only; custom tags are editable here. */}
                                <NodeTagEditor
                                    node={node}
                                    saving={savingNodeCapabilitiesId === node.id}
                                    onSave={caps => onUpdateNodeCapabilities(node, caps)}
                                />

                                {features.addNodeDaemonPicker && (
                                    <div className="mt-2 text-[11px] text-amber-300">
                                        {t('repoMesh.nodeList.liveDetailGraphOwned')}
                                    </div>
                                )}

                                <div className="mt-3 max-w-2xl" onClick={e => e.stopPropagation()}>
                                    <FormField label={t('repoMesh.nodeList.slotsLabel')}
                                        hint={t('repoMesh.nodeList.slotsHint')}>
                                        <NodeSlotEditor
                                            slots={Array.isArray(node.policy?.slots) ? node.policy!.slots : []}
                                            availableProviders={resolveNodeAvailableProviders(node, providersByDaemonId)}
                                            saving={savingNodeSlotsId === node.id}
                                            onSave={slots => onUpdateNodeSlots(node, slots)}
                                        />
                                    </FormField>

                                    {/* Standalone: node instruction */}
                                    {features.nodeInstruction && (
                                        <FormField label={t('repoMesh.nodeList.nodeInstruction')} hint={t('repoMesh.nodeList.nodeInstructionHint')}>
                                            <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                                                rows={3} value={nodeSystemPromptDrafts[node.id] ?? ''}
                                                onChange={e => { const next = e.target.value; onNodeSystemPromptDraftChange(node.id, next) }}
                                                onClick={e => e.stopPropagation()}
                                                disabled={savingNodeSystemPromptId === node.id}
                                                placeholder={t('repoMesh.nodeList.nodeInstructionPlaceholder')} />
                                            <div className="mt-2 flex items-center gap-2">
                                                <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                    onClick={e => { e.stopPropagation(); onSaveNodeSystemPrompt(node) }}
                                                    disabled={savingNodeSystemPromptId === node.id}>
                                                    {savingNodeSystemPromptId === node.id ? t('repoMesh.nodeList.saving') : t('repoMesh.nodeList.saveInstruction')}
                                                </button>
                                            </div>
                                        </FormField>
                                    )}

                                    {/* Per-node scheduling (priority + provider caps) moved to the
                                        Scheduling section so all scheduling knobs live in one place. */}
                                </div>
                            </div>

                            <button
                                className={`transition-colors bg-transparent border-none cursor-pointer ${features.addNodeDaemonPicker ? 'btn btn-sm text-text-muted hover:text-red-400' : 'text-text-muted hover:text-red-400'}`}
                                onClick={e => { e.stopPropagation(); onRemoveNode(node.id) }}
                                title={t('repoMesh.nodeList.removeNode')}>
                                {/* Both modes use the trash icon — standalone (addNodeDaemonPicker=false)
                                    previously showed IconX; unified with cloud per the icon-consistency pass. */}
                                <IconTrash size={14} />
                            </button>
                        </div>

                        {/* Read-only diagnostics (both modes) */}
                        <details className="mt-3 group" onClick={e => e.stopPropagation()}>
                            <summary className="cursor-pointer select-none text-[12px] text-text-muted hover:text-text-secondary inline-flex items-center gap-1">
                                <span className="transition-transform group-open:rotate-90" aria-hidden>▸</span> {t('repoMesh.nodeList.details')}
                            </summary>
                            <div className="mt-2 rounded-lg border border-border-subtle bg-bg-secondary/60 p-3 text-[12px] text-text-muted">
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <div><span className="text-text-secondary">{t('repoMesh.nodeList.nodeId')}</span> <span className="font-mono break-all">{node.id}</span></div>
                                    <div><span className="text-text-secondary">{t('repoMesh.nodeList.launchReady')}</span> <span className={priorityStatus.configured ? 'text-green-400' : 'text-amber-400'}>{priorityStatus.configured ? t('repoMesh.nodeList.launchReadyYes') : t('repoMesh.nodeList.launchReadyNo')}</span></div>
                                    <div><span className="text-text-secondary">{t('repoMesh.nodeList.repoRoot')}</span> <span className="font-mono break-all">{node.repoRoot || node.workspace}</span></div>
                                    <div><span className="text-text-secondary">{t('repoMesh.nodeList.activeSessionsLabel')}</span> {activeSessions.length}</div>
                                    {features.addNodeDaemonPicker && (
                                        <div><span className="text-text-secondary">{t('repoMesh.nodeList.added')}</span> {new Date((node as any).created_at || node.createdAt || Date.now()).toLocaleDateString()}</div>
                                    )}
                                </div>
                                <div className="mt-3">
                                    <div className="text-text-secondary mb-1">{t('repoMesh.nodeList.activeQueueAssignments')}</div>
                                    {activeAssignments.length === 0
                                        ? <div>{t('repoMesh.nodeList.noActiveAssignment')}</div>
                                        : <ul className="m-0 pl-4">{activeAssignments.map(task => <li key={task.id} className="font-mono">{describeNodeActiveAssignmentLabel(task)}</li>)}</ul>}
                                </div>
                                {activeSessions.length > 0 && (
                                    <div className="mt-3">
                                        <div className="text-text-secondary mb-1">{t('repoMesh.nodeList.activeSessions')}</div>
                                        <ul className="m-0 pl-4">{activeSessions.map(s => <li key={s.id} className="font-mono">{s.provider} / {s.status} / {s.id}</li>)}</ul>
                                    </div>
                                )}
                            </div>
                        </details>
                    </div>
                )
            })}
        </div>
    )
}

export default MeshMachineNodeGroup
