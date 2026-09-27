import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../../components/ui/InfoTip'
import { TechnicalDetails } from '../../components/ui/TechnicalDetails'
import { formatDateLocalized } from '../../utils/time'

import { EmptyState } from '../../components/ui/EmptyState'
import { FormField } from '../../components/ui/FormField'
import { IconFolder } from '../../components/Icons'
import NodeSlotEditor from './NodeSlotEditor'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import { IconTrash, NodeHealthBadge } from './icons'
import { findStatusNodeForNode, resolveNodeAvailableProviders } from './node-providers'
import { getCoordinatorNodeSessions, readCoordinatorNodeMachineStatus } from './node-runtime'
import type { RepoMeshNodeStatus } from '@adhdev/daemon-core'
import NodeTagEditor from './NodeTagEditor'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'
import {
    getNodeActiveAssignments,
    describeNodeActiveAssignmentLabel,
    describeNodeProviderPriority,
} from './MeshNodeList'
import type { MeshNode, MeshNodeListFeatures, MeshQueueEntry } from './types'


function daemonOwnerLabel(daemon: RepoMeshDaemonEntry | undefined, fallback?: string): string {
    return (daemon as any)?.ownerName || (daemon as any)?.userName || (daemon as any)?.user?.name || fallback || 'You'
}

interface Props {
    nodes: MeshNode[]
    /**
     * The coordinator's mesh_status nodes. Each node's live sessions and machine
     * reachability come from here (remote nodes via the coordinator's held
     * runtime) — never from the connected daemons' own session lists.
     */
    statusNodes?: RepoMeshNodeStatus[] | null
    meshQueue: MeshQueueEntry[]
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
 * Renders the node cards for ONE machine's worth of nodes (the per-machine tab
 * bar in MeshNodeList mounts exactly one group at a time). Each card is a
 * collapsed row; Edit reveals the editors. All per-node behavior (slots, tags,
 * instruction, remove, diagnostics) is unchanged — only disclosed on demand.
 */
export function MeshMachineNodeGroup({
    nodes,
    statusNodes,
    meshQueue,
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
    // Node cards start collapsed (machine · status · tools); "Edit" reveals the
    // slot editor, and tags / instruction / ids sit under its Advanced disclosure.
    const [editingIds, setEditingIds] = useState<Set<string>>(() => new Set())
    const toggleEditing = (nodeId: string) => setEditingIds(current => {
        const next = new Set(current)
        if (next.has(nodeId)) next.delete(nodeId)
        else next.add(nodeId)
        return next
    })

    if (nodes.length === 0) {
        return <EmptyState variant="compact" icon={<IconFolder size={14} />} title={t('mesh.nodeList.emptyTitle')} description={t('mesh.nodeList.emptyDescription')} />
    }

    return (
        <div className="flex flex-col gap-2">
            {nodes.map(node => {
                const priorityStatus = describeNodeProviderPriority(node)
                const activeAssignments = getNodeActiveAssignments(node, meshQueue)
                const statusNode = findStatusNodeForNode(node, statusNodes)
                const activeSessions = getCoordinatorNodeSessions(statusNode)
                const isSelected = selectedNodeId === node.id
                const isEditing = editingIds.has(node.id)
                // Reachability as the coordinator sees it; the config record's own
                // status only when the coordinator has no answer for this node yet.
                const health = readCoordinatorNodeMachineStatus(statusNode)
                    || (node as any).status
                    || (activeAssignments.length > 0 || activeSessions.length > 0 ? 'active' : 'enabled')
                const title = features.addNodeDaemonPicker
                    ? ((node as any).machine_label || (node as any).machine_nickname || (node as any).hostname || node.workspace)
                    : (node.workspace.split('/').pop() || node.workspace)
                const tools = priorityStatus.configured ? priorityStatus.label.split(' → ') : []
                const owner = features.addNodeDaemonPicker
                    ? t('mesh.nodeList.ownerMachine', {
                        owner: daemonOwnerLabel(daemons.find(d => d.id === String((node as any).daemon_id || '')), userName),
                        machine: (node as any).machine_label || (node as any).daemon_id || node.workspace,
                    })
                    : null

                return (
                    <div key={node.id}
                        className={`rounded-xl border bg-bg-glass px-4 py-3 transition-colors ${!features.addNodeDaemonPicker ? `cursor-pointer ${isSelected ? 'border-accent-primary/60' : 'border-border-subtle hover:border-accent-primary/35'}` : 'border-border-subtle'}`}
                        role={!features.addNodeDaemonPicker ? 'button' : undefined}
                        tabIndex={!features.addNodeDaemonPicker ? 0 : undefined}
                        onClick={!features.addNodeDaemonPicker ? () => onSelectNode(isSelected ? null : node.id) : undefined}
                        onKeyDown={!features.addNodeDaemonPicker ? e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelectNode(isSelected ? null : node.id) } } : undefined}
                    >
                        {/* Collapsed row: machine · status · tools, then Edit / remove. */}
                        <div className="flex items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-semibold text-text-primary" title={node.workspace}>{title}</span>
                                    {features.addNodeDaemonPicker && <NodeHealthBadge status={health} />}
                                    {!priorityStatus.configured && (
                                        <Tooltip content={t('mesh.nodeList.launchBlocked')}>
                                            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-3xs font-medium text-amber-400">{t('mesh.nodeList.launchBlockedChip')}</span>
                                        </Tooltip>
                                    )}
                                </div>
                                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-text-muted">
                                    {tools.length > 0 && <span className="truncate">{t('mesh.nodeList.usesTools', { tools: tools.join(', ') })}</span>}
                                    {features.addNodeDaemonPicker && (
                                        <span className="truncate font-mono text-3xs" title={node.workspace}>{node.workspace.split('/').filter(Boolean).pop() || node.workspace}</span>
                                    )}
                                </div>
                            </div>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm shrink-0"
                                aria-expanded={isEditing}
                                onClick={e => { e.stopPropagation(); toggleEditing(node.id) }}
                            >
                                {isEditing ? t('common.done') : t('common.edit')}
                            </button>
                            <button
                                type="button"
                                className="shrink-0 bg-transparent border-none cursor-pointer text-text-muted transition-colors hover:text-red-400"
                                onClick={e => { e.stopPropagation(); onRemoveNode(node.id) }}
                                aria-label={t('mesh.nodeList.removeNode')}
                                title={t('mesh.nodeList.removeNode')}>
                                <IconTrash size={14} />
                            </button>
                        </div>

                        {isEditing && (
                            <div className="mt-3 max-w-2xl cursor-default" onClick={e => e.stopPropagation()}>
                                <FormField label={t('mesh.nodeList.slotsLabel')} hint={t('mesh.nodeList.slotsHint')}>
                                    <NodeSlotEditor
                                        slots={Array.isArray(node.policy?.slots) ? node.policy!.slots : []}
                                        availableProviders={resolveNodeAvailableProviders(node, providersByDaemonId, statusNode)}
                                        saving={savingNodeSlotsId === node.id}
                                        onSave={slots => onUpdateNodeSlots(node, slots)}
                                    />
                                </FormField>

                                <details className="group">
                                    <summary className="cursor-pointer select-none text-xs text-text-muted hover:text-text-secondary inline-flex items-center gap-1">
                                        <span className="transition-transform group-open:rotate-90" aria-hidden>▸</span> {t('mesh.nodeList.advanced')}
                                    </summary>
                                    <div className="mt-3 flex flex-col gap-3">
                                        {/* Routing tags — what a task's required_tags can target on this node. */}
                                        <NodeTagEditor
                                            node={node}
                                            saving={savingNodeCapabilitiesId === node.id}
                                            onSave={caps => onUpdateNodeCapabilities(node, caps)}
                                        />

                                        {/* Node instruction — a text area, so it keeps its own Save. */}
                                        {features.nodeInstruction && (
                                            <FormField label={t('mesh.nodeList.nodeInstruction')} hint={t('mesh.nodeList.nodeInstructionHint')} className="mb-0">
                                                <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                                                    rows={3} value={nodeSystemPromptDrafts[node.id] ?? ''}
                                                    onChange={e => { const next = e.target.value; onNodeSystemPromptDraftChange(node.id, next) }}
                                                    disabled={savingNodeSystemPromptId === node.id}
                                                    placeholder={t('mesh.nodeList.nodeInstructionPlaceholder')} />
                                                <div className="mt-2 flex items-center gap-2">
                                                    <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                        onClick={() => onSaveNodeSystemPrompt(node)}
                                                        disabled={savingNodeSystemPromptId === node.id}>
                                                        {savingNodeSystemPromptId === node.id ? t('mesh.nodeList.saving') : t('mesh.nodeList.saveInstruction')}
                                                    </button>
                                                </div>
                                            </FormField>
                                        )}

                                        {/* Read-only runtime + ids */}
                                        <div className="rounded-lg border border-border-subtle bg-bg-secondary/60 p-3 text-xs text-text-muted">
                                            {owner && <div className="mb-2">{owner}</div>}
                                            <div className="grid gap-2 sm:grid-cols-2">
                                                <div><span className="text-text-secondary">{t('mesh.nodeList.repoRoot')}</span> <span className="font-mono break-all">{node.repoRoot || node.workspace}</span></div>
                                                <div><span className="text-text-secondary">{t('mesh.nodeList.activeSessionsLabel')}</span> {activeSessions.length}</div>
                                                {features.addNodeDaemonPicker && (
                                                    <div><span className="text-text-secondary">{t('mesh.nodeList.added')}</span> {formatDateLocalized((node as any).created_at || node.createdAt) || '—'}</div>
                                                )}
                                            </div>
                                            <div className="mt-3">
                                                <div className="text-text-secondary mb-1">{t('mesh.nodeList.activeQueueAssignments')}</div>
                                                {activeAssignments.length === 0
                                                    ? <div>{t('mesh.nodeList.noActiveAssignment')}</div>
                                                    : <ul className="m-0 pl-4">{activeAssignments.map(task => <li key={task.id} className="font-mono">{describeNodeActiveAssignmentLabel(task)}</li>)}</ul>}
                                            </div>
                                            {activeSessions.length > 0 && (
                                                <div className="mt-3">
                                                    <div className="text-text-secondary mb-1">{t('mesh.nodeList.activeSessions')}</div>
                                                    <ul className="m-0 pl-4">{activeSessions.map(s => <li key={s.id} className="font-mono">{s.provider} / {s.status}</li>)}</ul>
                                                </div>
                                            )}
                                            <TechnicalDetails
                                                className="mt-3"
                                                rows={[
                                                    { label: t('mesh.nodeList.nodeId'), value: node.id },
                                                    ...activeSessions.map(s => ({ label: t('mesh.nodeList.activeSessions'), value: s.id })),
                                                ]}
                                            />
                                        </div>
                                    </div>
                                </details>
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

export default MeshMachineNodeGroup
