import { Section } from '../../components/ui/Section'
import { EmptyState } from '../../components/ui/EmptyState'
import { FormField, Input } from '../../components/ui/FormField'
import { IconX, IconFolder } from '../../components/Icons'
import ProviderPriorityEditor from '../../components/provider-priority/ProviderPriorityEditor'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import { IconTrash, IconPlus, NodeHealthBadge } from './icons'
import type { MeshNode, MeshQueueEntry, MeshNodeListFeatures, ProviderPriorityDrafts } from './types'

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
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => { if (seen.has(type)) return false; seen.add(type); return true })
}

function describeNodeProviderPriority(node: MeshNode): { configured: boolean; label: string; launchBlockedMessage?: string } {
    const pp = readNodeProviderPriority(node)
    if (!pp.length) return { configured: false, label: 'not configured', launchBlockedMessage: 'launch not ready unless an explicit provider is selected' }
    return { configured: true, label: pp.join(' → ') }
}

function isWorktreeNode(node: MeshNode): boolean {
    return node.isLocalWorktree === true
}

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

function daemonLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}

function daemonOwnerLabel(daemon: RepoMeshDaemonEntry | undefined, fallback?: string): string {
    return (daemon as any)?.ownerName || (daemon as any)?.userName || (daemon as any)?.user?.name || fallback || 'You'
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

    // Provider priority drafts
    nodeProviderPriorityDrafts: ProviderPriorityDrafts
    onNodeProviderPriorityDraftChange: (nodeId: string, next: string[]) => void
    availableCliProviders: AvailableCliProviderOption[]
    savingNodePolicyId: string | null
    onUpdateNodeProviderPriority: (node: MeshNode) => void

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
    nodeProviderPriorityDrafts,
    onNodeProviderPriorityDraftChange,
    availableCliProviders,
    savingNodePolicyId,
    onUpdateNodeProviderPriority,
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
}: Props) {
    return (
        <Section
            title={features.addNodeDaemonPicker ? `Attached machine daemons (${nodes.length})` : 'Nodes'}
            description={features.addNodeDaemonPicker
                ? 'Setup inventory only. Live graph, git, session, queue, and node detail truth is owned by the Mesh Host status above.'
                : 'Workspaces participating in this mesh.'}
        >
            {/* Cloud: daemon candidate picker */}
            {features.addNodeDaemonPicker && (
                <div className="mb-4 rounded-xl border border-border-subtle bg-bg-secondary/60 p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                            <div className="text-sm font-semibold text-text-primary">Machine daemon candidates</div>
                            <div className="text-[12px] text-text-muted">Choose connected daemons to attach to the selected Mesh Host setup.</div>
                        </div>
                        <span className="text-[11px] text-text-muted">{attachableDaemons.length} available</span>
                    </div>
                    {daemons.length === 0 ? (
                        <div className="text-[12px] text-text-muted">No connected machine daemons are currently available.</div>
                    ) : attachableDaemons.length === 0 ? (
                        <div className="text-[12px] text-text-muted">All connected machine daemons are already attached.</div>
                    ) : (
                        <div className="grid gap-2 md:grid-cols-2">
                            {attachableDaemons.map(d => (
                                <button key={d.id} type="button"
                                    className={`text-left rounded-lg border px-3 py-2 transition-colors ${d.id === coordinatorDaemonId ? 'border-accent-primary/50 bg-accent-primary/10' : 'border-border-subtle bg-bg-primary hover:border-border-default'}`}
                                    onClick={() => {
                                        onNodeDaemonIdChange(d.id)
                                        onNodeWorkspaceChange('')
                                        onNodeCustomPathChange(false)
                                        onNodeProviderPriorityChange(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((d as any).availableProviders || [])))
                                        onShowAddNode()
                                    }}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-medium truncate">{daemonLabel(d)}</span>
                                        {d.id === coordinatorDaemonId && <span className="text-[10px] text-accent-primary">selected host</span>}
                                    </div>
                                    <div className="mt-1 text-[11px] text-text-muted font-mono truncate">{d.id}</div>
                                    <div className="mt-1 text-[11px] text-text-muted">{(d.workspaces || []).length} workspace(s) detected</div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Add node button */}
            {!showAddNode && (
                <button className="btn btn-primary btn-sm mb-4 inline-flex items-center gap-1.5" onClick={onShowAddNode}>
                    <IconPlus size={13} /> {features.addNodeDaemonPicker ? 'Attach Machine Daemon' : '+ Add Node'}
                </button>
            )}

            {/* Add node form */}
            {showAddNode && (
                <div className="mb-4 p-4 rounded-xl border border-accent-primary/30 bg-bg-glass animate-[fadeIn_0.3s_ease-out]">
                    <div className="flex justify-between items-center mb-3">
                        <h4 className="text-sm font-bold">{features.addNodeDaemonPicker ? 'Attach Machine Daemon' : 'Add Node'}</h4>
                        <button onClick={() => { onCancelAddNode(); onNodeDaemonIdChange(''); onNodeCustomPathChange(false) }} className="text-text-muted cursor-pointer bg-transparent border-none"><IconX size={16} /></button>
                    </div>

                    {/* Cloud: machine picker */}
                    {features.addNodeDaemonPicker && (
                        <FormField label="Machine">
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={nodeDaemonId} onChange={e => {
                                    onNodeDaemonIdChange(e.target.value)
                                    onNodeWorkspaceChange('')
                                    onNodeCustomPathChange(false)
                                    onNodeProviderPriorityChange(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((daemons.find(d => d.id === e.target.value) as any)?.availableProviders || [])))
                                }}>
                                <option value="">Select a machine...</option>
                                {daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
                            </select>
                        </FormField>
                    )}

                    {/* Workspace picker */}
                    {(features.addNodeDaemonPicker ? nodeDaemonId : true) && (
                        <FormField label="Workspace Path">
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
                                    <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0" onClick={() => { onNodeCustomPathChange(true); onNodeWorkspaceChange('') }}>Or enter a custom path →</button>
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
                                                <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0 mt-1" onClick={() => { onNodeCustomPathChange(false); onNodeWorkspaceChange('') }}>← Pick from saved workspaces</button>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </FormField>
                    )}

                    <FormField label={features.addNodeDaemonPicker ? 'Default CLI providers' : 'Provider Priority'} hint="Order used when launching without an explicit provider.">
                        <ProviderPriorityEditor
                            value={nodeProviderPriority}
                            availableProviders={features.addNodeDaemonPicker ? nodePickerProviders : availableCliProviders}
                            onChange={onNodeProviderPriorityChange}
                        />
                    </FormField>

                    <div className="flex gap-2 mt-3">
                        <button onClick={onAddNode} disabled={!nodeWorkspace.trim() || (features.addNodeDaemonPicker && !nodeDaemonId)} className="btn btn-primary btn-sm">Add</button>
                        <button onClick={() => { onCancelAddNode(); onNodeDaemonIdChange(''); onNodeCustomPathChange(false) }} className="btn btn-secondary btn-sm">Cancel</button>
                    </div>
                </div>
            )}

            {/* Cloud: setup inventory warning */}
            {features.addNodeDaemonPicker && (
                <div className="mb-3 text-[12px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    Setup inventory only — live git/session/branch detail is shown in the graph popup after direct aggregate mesh_status truth is available from the Mesh Host.
                </div>
            )}

            {nodes.length === 0 ? (
                <EmptyState icon={<IconFolder />} title="No nodes" description="Add a workspace to this mesh." />
            ) : (
                <div className="flex flex-col gap-2">
                    {nodes.map(node => {
                        const priorityStatus = describeNodeProviderPriority(node)
                        const activeAssignments = getNodeActiveAssignments(node, meshQueue)
                        const activeSessions = getNodeActiveSessions(node, activeDaemon)
                        const isSelected = selectedNodeId === node.id
                        const worktree = isWorktreeNode(node)
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
                                            {activeAssignments.length > 0 && !features.addNodeDaemonPicker && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/25">
                                                    {activeAssignments.length} active task{activeAssignments.length === 1 ? '' : 's'}
                                                </span>
                                            )}
                                            {worktree && (
                                                <span className={`text-[10px] px-2 py-0.5 rounded-full ${features.addNodeDaemonPicker ? 'bg-cyan-400/10 text-cyan-300 border border-cyan-400/30' : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/25'}`}>worktree</span>
                                            )}
                                            {features.addNodeDaemonPicker && <span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[10px] font-medium text-text-muted">setup inventory</span>}
                                        </div>

                                        {features.addNodeDaemonPicker && (
                                            <div className="text-[11px] text-text-muted">
                                                Owner: {daemonOwnerLabel(daemons.find(d => d.id === String((node as any).daemon_id || '')), userName)} · Machine: {(node as any).machine_label || (node as any).daemon_id || node.workspace}
                                            </div>
                                        )}

                                        <div className="text-[10px] text-text-muted font-mono">{node.workspace}</div>

                                        {worktree && (
                                            <div className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${features.addNodeDaemonPicker ? 'border border-cyan-400/20 bg-cyan-400/10 text-cyan-200' : 'border border-cyan-500/20 bg-cyan-500/10 text-cyan-200'}`}>
                                                Worktree node{node.worktreeBranch ? ` · ${node.worktreeBranch}` : ''}. Provider priority saved here is node-local and disappears when removed.
                                            </div>
                                        )}

                                        {features.addNodeDaemonPicker && (
                                            <div className="mt-2 text-[11px] text-amber-300">
                                                Live branch/git/session detail is graph-owned; use the node popup in the live graph above.
                                            </div>
                                        )}

                                        <div className={`mt-3 max-w-2xl ${!features.addNodeDaemonPicker ? '' : ''}`} onClick={e => e.stopPropagation()}>
                                            <FormField label={features.addNodeDaemonPicker ? 'Default CLI providers' : 'Provider priority'}
                                                hint={worktree
                                                    ? 'Worktree-local launch defaults. Configure the source node for durable defaults.'
                                                    : features.addNodeDaemonPicker
                                                        ? 'Used for coordinator/session launches when no provider is selected explicitly.'
                                                        : 'Used when launches omit an explicit provider.'}>
                                                <ProviderPriorityEditor
                                                    value={nodeProviderPriorityDrafts[node.id] ?? readNodeProviderPriority(node)}
                                                    availableProviders={availableCliProviders}
                                                    onChange={next => onNodeProviderPriorityDraftChange(node.id, next)}
                                                    disabled={savingNodePolicyId === node.id}
                                                    saveButton={(
                                                        <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                            onClick={e => { e.stopPropagation(); onUpdateNodeProviderPriority(node) }}
                                                            disabled={savingNodePolicyId === node.id}>
                                                            {savingNodePolicyId === node.id ? 'Saving...' : features.addNodeDaemonPicker ? 'Save defaults' : 'Save policy'}
                                                        </button>
                                                    )}
                                                />
                                                <div className="mt-2 text-[12px]">
                                                    <span className="text-text-muted">{features.addNodeDaemonPicker ? 'Saved default order: ' : 'Effective provider priority: '}</span>
                                                    <span className={priorityStatus.configured ? 'text-text-primary font-mono' : 'text-amber-400'}>{priorityStatus.label}</span>
                                                    {!priorityStatus.configured && priorityStatus.launchBlockedMessage && (
                                                        <span className="ml-2 text-amber-400">({priorityStatus.launchBlockedMessage})</span>
                                                    )}
                                                </div>
                                            </FormField>

                                            {/* Standalone: node instruction */}
                                            {features.nodeInstruction && (
                                                <FormField label="Node instruction (optional)" hint="Surfaced in the coordinator system prompt as 📌 Node instruction.">
                                                    <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                                                        rows={3} value={nodeSystemPromptDrafts[node.id] ?? ''}
                                                        onChange={e => { const next = e.target.value; onNodeSystemPromptDraftChange(node.id, next) }}
                                                        onClick={e => e.stopPropagation()}
                                                        disabled={savingNodeSystemPromptId === node.id}
                                                        placeholder="e.g. 'Run only smoke tests here', 'Use opus on this node'" />
                                                    <div className="mt-2 flex items-center gap-2">
                                                        <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                            onClick={e => { e.stopPropagation(); onSaveNodeSystemPrompt(node) }}
                                                            disabled={savingNodeSystemPromptId === node.id}>
                                                            {savingNodeSystemPromptId === node.id ? 'Saving…' : 'Save instruction'}
                                                        </button>
                                                    </div>
                                                </FormField>
                                            )}
                                        </div>
                                    </div>

                                    <button
                                        className={`transition-colors bg-transparent border-none cursor-pointer ${features.addNodeDaemonPicker ? 'btn btn-sm text-text-muted hover:text-red-400' : 'text-text-muted hover:text-red-400'}`}
                                        onClick={e => { e.stopPropagation(); onRemoveNode(node.id) }}
                                        title="Remove node">
                                        {features.addNodeDaemonPicker ? <IconTrash size={14} /> : <IconX size={14} />}
                                    </button>
                                </div>

                                {/* Standalone: expanded detail */}
                                {!features.addNodeDaemonPicker && isSelected && (
                                    <div className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary/60 p-3 text-[12px] text-text-muted">
                                        <div className="grid gap-2 sm:grid-cols-2">
                                            <div><span className="text-text-secondary">Node ID:</span> <span className="font-mono">{node.id}</span></div>
                                            <div><span className="text-text-secondary">Launch ready:</span> <span className={priorityStatus.configured ? 'text-green-400' : 'text-amber-400'}>{priorityStatus.configured ? 'yes' : 'provider priority not configured'}</span></div>
                                            <div><span className="text-text-secondary">Repo root:</span> <span className="font-mono">{node.repoRoot || node.workspace}</span></div>
                                            <div><span className="text-text-secondary">Active sessions:</span> {activeSessions.length}</div>
                                        </div>
                                        <div className="mt-3">
                                            <div className="text-text-secondary mb-1">Active queue assignments</div>
                                            {activeAssignments.length === 0
                                                ? <div>No active assigned queue task for this node.</div>
                                                : <ul className="m-0 pl-4">{activeAssignments.map(t => <li key={t.id} className="font-mono">{describeNodeActiveAssignmentLabel(t)}</li>)}</ul>}
                                        </div>
                                        {activeSessions.length > 0 && (
                                            <div className="mt-3">
                                                <div className="text-text-secondary mb-1">Active sessions</div>
                                                <ul className="m-0 pl-4">{activeSessions.map(s => <li key={s.id} className="font-mono">{s.provider} / {s.status} / {s.id}</li>)}</ul>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Cloud: node ID footer */}
                                {features.addNodeDaemonPicker && (
                                    <div className="mt-2 text-[11px] text-text-muted">
                                        <span className="mr-3">Node ID: {node.id.slice(0, 16)}...</span>
                                        <span>Added: {new Date((node as any).created_at || node.createdAt || Date.now()).toLocaleDateString()}</span>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </Section>
    )
}
