/**
 * RepoMesh — Standalone/OSS mesh management page
 *
 * Uses daemon commands (list_meshes, create_mesh, etc.) via WS transport.
 * No cloud API dependency — works with local ~/.adhdev/meshes.json.
 *
 * Coordinator: launches a regular CLI session with mesh context,
 * just like clicking "+" on the dashboard.
 */
import { useState, useEffect, useCallback } from 'react'

import { useTransport } from '../context/TransportContext'
import { useBaseDaemons } from '../context/BaseDaemonContext'
import AppPage from '../components/ui/AppPage'
import { Section } from '../components/ui/Section'
import { EmptyState } from '../components/ui/EmptyState'
import { AlertBanner } from '../components/ui/AlertBanner'
import { FormField, Input } from '../components/ui/FormField'
import { IconX, IconMesh, IconFolder } from '../components/Icons'
import MeshCoordinatorManualSetupPanel from '../components/MeshCoordinatorManualSetupPanel'
import {
    buildManualCoordinatorSetup,
    type MeshCoordinatorMetadata,
} from '../utils/mesh-coordinator-setup'

// ─── Types (matches daemon-core LocalMeshEntry shape) ───
interface MeshNode {
    id: string
    workspace: string
    repoRoot?: string
    providerPriority?: string[]
    policy?: {
        providerPriority?: string[]
        readOnly?: boolean
    }
}

interface MeshEntry {
    id: string
    name: string
    repoIdentity: string
    repoRemoteUrl?: string
    defaultBranch?: string
    policy?: Record<string, any>
    nodes: MeshNode[]
    createdAt: string
    updatedAt: string
}

interface AvailableCliAgent {
    id: string
    name: string
    meshCoordinator?: MeshCoordinatorMetadata
}

const DEFAULT_REPO_MESH_PROVIDER_PRIORITY = 'hermes-cli, claude-cli, codex-cli, gemini-cli'
type RepoMeshSessionCleanupMode = 'preserve' | 'stop' | 'delete_stopped' | 'stop_and_delete'

const SESSION_CLEANUP_MODE_OPTIONS: Array<{ value: RepoMeshSessionCleanupMode; label: string; description: string }> = [
    { value: 'preserve', label: 'Preserve history and runtimes', description: 'Keep completed chat history and leave live runtimes alone.' },
    { value: 'stop', label: 'Stop live runtimes only', description: 'Release running session processes, but keep chat records/transcripts.' },
    { value: 'delete_stopped', label: 'Delete stopped sessions only', description: 'Clean completed/stopped chat clutter without killing live runtimes.' },
    { value: 'stop_and_delete', label: 'Stop and delete sessions', description: 'Stop matching runtimes, then remove their session records/transcripts.' },
]

const DEFAULT_MESH_POLICY: Record<string, any> = {
    requirePreTaskCheckpoint: false,
    requirePostTaskCheckpoint: true,
    requireApprovalForPush: true,
    requireApprovalForDestructiveGit: true,
    dirtyWorkspaceBehavior: 'warn',
    maxParallelTasks: 2,
    sessionCleanupOnNodeRemove: 'preserve',
}

const CANONICAL_REPO_MESH_PROVIDER_TYPES = new Set([
    'hermes-cli',
    'claude-cli',
    'codex-cli',
    'gemini-cli',
])

function normalizeProviderPriorityToken(type: string): string | undefined {
    const trimmed = type.trim()
    if (!trimmed) return undefined
    const lower = trimmed.toLowerCase()
    return CANONICAL_REPO_MESH_PROVIDER_TYPES.has(lower) ? lower : trimmed
}

function parseProviderPriorityInput(value: string): string[] {
    const seen = new Set<string>()
    return value
        .split(/[\s,]+/)
        .map(normalizeProviderPriorityToken)
        .filter((type): type is string => !!type)
        .filter(type => {
            if (seen.has(type)) return false
            seen.add(type)
            return true
        })
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
        .filter(type => {
            if (seen.has(type)) return false
            seen.add(type)
            return true
        })
}

function describeNodeProviderPriority(node: MeshNode): { configured: boolean; label: string; launchBlockedMessage?: string } {
    const providerPriority = readNodeProviderPriority(node)
    if (!providerPriority.length) {
        return {
            configured: false,
            label: 'not configured',
            launchBlockedMessage: 'launch not ready unless an explicit provider is selected',
        }
    }
    return { configured: true, label: providerPriority.join(' → ') }
}

function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return { ...DEFAULT_MESH_POLICY, ...(mesh?.policy || {}) }
}

export function RepoMeshHermesMcpConfig({
    meshId,
    availableCliAgents,
}: {
    meshId: string
    availableCliAgents: AvailableCliAgent[]
}) {
    const hermesAgent = availableCliAgents.find(agent => {
        const id = agent.id.toLowerCase()
        const name = agent.name.toLowerCase()
        return id === 'hermes-cli' || id.includes('hermes') || name.includes('hermes')
    })
    const manualSetup = buildManualCoordinatorSetup(hermesAgent?.meshCoordinator, { meshId })

    if (!manualSetup) return null

    return (
        <Section
            title="Hermes MCP Config"
            description="Hermes does not auto-import repo-local .mcp.json. Add this YAML under mcp_servers in Hermes config, then start a fresh Hermes session."
        >
            <MeshCoordinatorManualSetupPanel
                setup={manualSetup}
                providerName={hermesAgent?.name || 'Hermes CLI'}
            />
        </Section>
    )
}

export default function RepoMesh() {
    const { sendCommand } = useTransport()
    const { ides } = useBaseDaemons()


    // Find the daemon ID (standalone = single daemon)
    const daemon = (ides as any[]).find((d: any) => d.daemonMode || d.type === 'adhdev-daemon')
    const daemonId = daemon?.id || ''

    // Extract available CLI agents from daemon status
    const availableCliAgents: AvailableCliAgent[] = []
    if (daemon) {
        const providers = (daemon as any).availableProviders || []
        for (const p of providers) {
            if (p.category === 'cli') {
                availableCliAgents.push({
                    id: p.type || p.id,
                    name: p.displayName || p.name || p.type,
                    meshCoordinator: p.meshCoordinator,
                })
            }
        }
    }

    // State
    const [meshes, setMeshes] = useState<MeshEntry[]>([])
    const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [savingPolicy, setSavingPolicy] = useState(false)
    const [savingNodePolicyId, setSavingNodePolicyId] = useState<string | null>(null)
    const [nodeProviderPriorityDrafts, setNodeProviderPriorityDrafts] = useState<Record<string, string>>({})

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')
    const [nodeProviderPriority, setNodeProviderPriority] = useState(DEFAULT_REPO_MESH_PROVIDER_PRIORITY)

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

    useEffect(() => {
        setNodeProviderPriorityDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, readNodeProviderPriority(node).join(', ')]),
        ))
    }, [selectedMesh])

    // ─── Data loading ───
    const loadMeshes = useCallback(async () => {
        if (!daemonId) return
        setLoading(true)
        try {
            const res: any = await sendCommand(daemonId, 'list_meshes')
            if (res?.success) {
                setMeshes(res.meshes || [])
                setError(null)
            } else {
                setError(res?.error || 'Failed to load meshes')
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to load meshes')
        } finally {
            setLoading(false)
        }
    }, [daemonId, sendCommand])

    useEffect(() => { void loadMeshes() }, [loadMeshes])

    // ─── Actions ───
    async function handleCreate() {
        if (!daemonId || !createName.trim()) return
        try {
            const res: any = await sendCommand(daemonId, 'create_mesh', {
                name: createName.trim(),
                repoIdentity: createRepoIdentity.trim() || undefined,
            })
            if (res?.success) {
                setShowCreate(false)
                setCreateName('')
                setCreateRepoIdentity('')
                await loadMeshes()
                setSelectedMeshId(res.mesh?.id || null)
            } else {
                setError(res?.error || 'Create failed')
            }
        } catch (e: any) {
            setError(e?.message || 'Create failed')
        }
    }

    async function handleDelete(meshId: string) {
        if (!daemonId || !confirm('Delete this mesh?')) return
        try {
            await sendCommand(daemonId, 'delete_mesh', { meshId })
            setSelectedMeshId(null)
            await loadMeshes()
        } catch (e: any) {
            setError(e?.message || 'Delete failed')
        }
    }

    async function handleAddNode() {
        if (!daemonId || !selectedMeshId || !nodeWorkspace.trim()) return
        try {
            const res: any = await sendCommand(daemonId, 'add_mesh_node', {
                meshId: selectedMeshId,
                workspace: nodeWorkspace.trim(),
                providerPriority: parseProviderPriorityInput(nodeProviderPriority),
            })
            if (res?.success) {
                setShowAddNode(false)
                setNodeWorkspace('')
                setNodeProviderPriority(DEFAULT_REPO_MESH_PROVIDER_PRIORITY)
                await loadMeshes()
            } else {
                setError(res?.error || 'Add node failed')
            }
        } catch (e: any) {
            setError(e?.message || 'Add node failed')
        }
    }

    async function handleRemoveNode(nodeId: string) {
        if (!daemonId || !selectedMeshId) return
        const policy = readMeshPolicy(selectedMesh)
        const cleanupLabel = SESSION_CLEANUP_MODE_OPTIONS.find(option => option.value === policy.sessionCleanupOnNodeRemove)?.label || 'Preserve history and runtimes'
        if (!confirm(`Remove this node?\n\nNode removal cleanup policy: ${cleanupLabel}`)) return
        try {
            await sendCommand(daemonId, 'remove_mesh_node', { meshId: selectedMeshId, nodeId })
            await loadMeshes()
        } catch (e: any) {
            setError(e?.message || 'Remove node failed')
        }
    }

    async function handleUpdatePolicy(patch: Record<string, unknown>) {
        if (!daemonId || !selectedMeshId) return
        const nextPolicy = { ...readMeshPolicy(selectedMesh), ...patch }
        try {
            setSavingPolicy(true)
            setError(null)
            const res: any = await sendCommand(daemonId, 'update_mesh', {
                meshId: selectedMeshId,
                policy: nextPolicy,
            })
            if (res?.success === false) {
                setError(res.error || 'Policy update failed')
                return
            }
            await loadMeshes()
        } catch (e: any) {
            setError(e?.message || 'Policy update failed')
        } finally {
            setSavingPolicy(false)
        }
    }

    async function handleUpdateNodeProviderPriority(node: MeshNode) {
        if (!daemonId || !selectedMeshId) return
        const providerPriority = parseProviderPriorityInput(nodeProviderPriorityDrafts[node.id] || '')
        const nextPolicy = { ...(node.policy || {}) }
        delete (nextPolicy as any).provider_priority
        if (providerPriority.length) {
            nextPolicy.providerPriority = providerPriority
        } else {
            delete nextPolicy.providerPriority
        }
        try {
            setSavingNodePolicyId(node.id)
            setError(null)
            const res: any = await sendCommand(daemonId, 'update_mesh_node', {
                meshId: selectedMeshId,
                nodeId: node.id,
                policy: nextPolicy,
            })
            if (res?.success === false) {
                setError(res.error || 'Node policy update failed')
                return
            }
            await loadMeshes()
        } catch (e: any) {
            setError(e?.message || 'Node policy update failed')
        } finally {
            setSavingNodePolicyId(null)
        }
    }

    // ─── Render: no daemon ───
    if (!daemonId) {
        return (
            <AppPage icon={<IconMesh />} title="Repo Mesh" subtitle="Multi-workspace orchestration">
                <div className="text-sm text-text-muted p-4">Waiting for daemon connection...</div>
            </AppPage>
        )
    }

    // ─── Render: mesh list ───
    if (!selectedMesh) {
        return (
            <AppPage
                icon={<IconMesh />}
                title="Repo Mesh"
                subtitle="Multi-workspace orchestration"
                actions={
                    <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
                        + Create Mesh
                    </button>
                }
            >
                {error && <AlertBanner variant="error" className="mb-4">{error}</AlertBanner>}

                {showCreate && (
                    <Section title="New Mesh">
                        <div className="flex flex-col gap-3">
                            <FormField label="Name">
                                <Input
                                    value={createName}
                                    onChange={e => setCreateName(e.target.value)}
                                    placeholder="my-project-mesh"
                                    autoFocus
                                />
                            </FormField>
                            <FormField label="Repo Identity (optional)">
                                <Input
                                    value={createRepoIdentity}
                                    onChange={e => setCreateRepoIdentity(e.target.value)}
                                    placeholder="github.com/user/repo"
                                />
                            </FormField>
                            <div className="flex gap-2">
                                <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={!createName.trim()}>
                                    Create
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </Section>
                )}

                {loading ? (
                    <div className="text-sm text-text-muted p-4">Loading meshes...</div>
                ) : meshes.length === 0 ? (
                    <EmptyState icon={<IconMesh />} title="No meshes" description="Create a mesh to get started." />
                ) : (
                    <div className="flex flex-col gap-2">
                        {meshes.map(mesh => (
                            <button
                                key={mesh.id}
                                className="text-left w-full p-4 rounded-xl border border-border-subtle bg-bg-panel hover:border-accent-primary/40 transition-colors"
                                onClick={() => setSelectedMeshId(mesh.id)}
                            >
                                <div className="font-semibold text-sm">{mesh.name}</div>
                                <div className="text-xs text-text-muted mt-0.5 font-mono">{mesh.repoIdentity || 'No repo identity'}</div>
                                <div className="text-[10px] text-text-muted mt-1">{mesh.nodes.length} node(s)</div>
                            </button>
                        ))}
                    </div>
                )}
            </AppPage>
        )
    }

    // ─── Render: mesh detail ───
    const policy = readMeshPolicy(selectedMesh)
    return (
        <AppPage
            icon={<IconMesh />}
            title={selectedMesh.name}
            subtitle={selectedMesh.repoIdentity || 'Repo Mesh'}
            actions={
                <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={() => setSelectedMeshId(null)}>← Back</button>
                    <button className="btn btn-sm" style={{ color: 'var(--color-red-400)' }} onClick={() => handleDelete(selectedMesh.id)}>Delete</button>
                </div>
            }
        >
            {error && <AlertBanner variant="error" className="mb-4">{error}</AlertBanner>}

            <Section
                title="Policy"
                description="Coordinator safety defaults and node-removal session cleanup behavior for this local mesh."
            >
                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Checkpoint before task">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.requirePreTaskCheckpoint ? 'yes' : 'no'}
                            onChange={e => handleUpdatePolicy({ requirePreTaskCheckpoint: e.target.value === 'yes' })}
                            disabled={savingPolicy}
                        >
                            <option value="no">No</option>
                            <option value="yes">Yes</option>
                        </select>
                    </FormField>
                    <FormField label="Checkpoint after task">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.requirePostTaskCheckpoint ? 'yes' : 'no'}
                            onChange={e => handleUpdatePolicy({ requirePostTaskCheckpoint: e.target.value === 'yes' })}
                            disabled={savingPolicy}
                        >
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                        </select>
                    </FormField>
                    <FormField label="Push approval">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.requireApprovalForPush ? 'required' : 'not_required'}
                            onChange={e => handleUpdatePolicy({ requireApprovalForPush: e.target.value === 'required' })}
                            disabled={savingPolicy}
                        >
                            <option value="required">Require approval before push</option>
                            <option value="not_required">Do not require approval</option>
                        </select>
                    </FormField>
                    <FormField label="Destructive git approval">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.requireApprovalForDestructiveGit ? 'required' : 'not_required'}
                            onChange={e => handleUpdatePolicy({ requireApprovalForDestructiveGit: e.target.value === 'required' })}
                            disabled={savingPolicy}
                        >
                            <option value="required">Require approval</option>
                            <option value="not_required">Do not require approval</option>
                        </select>
                    </FormField>
                    <FormField label="Dirty workspace behavior">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.dirtyWorkspaceBehavior || 'warn'}
                            onChange={e => handleUpdatePolicy({ dirtyWorkspaceBehavior: e.target.value })}
                            disabled={savingPolicy}
                        >
                            <option value="warn">Warn and continue</option>
                            <option value="block">Block task</option>
                            <option value="checkpoint_then_continue">Checkpoint then continue</option>
                        </select>
                    </FormField>
                    <FormField label="Max parallel tasks">
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={String(policy.maxParallelTasks ?? 2)}
                            onChange={e => handleUpdatePolicy({ maxParallelTasks: Number(e.target.value) })}
                            disabled={savingPolicy}
                        >
                            {[1, 2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    </FormField>
                </div>
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                    <FormField
                        label="Node removal session cleanup"
                        hint="Separate transcript cleanup from runtime/process cleanup. Preserve is safest when completed work may need review."
                    >
                        <select
                            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.sessionCleanupOnNodeRemove || 'preserve'}
                            onChange={e => handleUpdatePolicy({ sessionCleanupOnNodeRemove: e.target.value })}
                            disabled={savingPolicy}
                        >
                            {SESSION_CLEANUP_MODE_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </FormField>
                    <div className="mt-2 text-[12px] text-text-muted">
                        {SESSION_CLEANUP_MODE_OPTIONS.find(option => option.value === policy.sessionCleanupOnNodeRemove)?.description || SESSION_CLEANUP_MODE_OPTIONS[0].description}
                    </div>
                </div>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">Saving policy...</div>}
            </Section>

            {/* Nodes */}
            <Section
                title="Nodes"
                description="Workspaces participating in this mesh."
            >
                <div className="flex justify-end mb-3">
                    <button className="btn btn-primary btn-sm" onClick={() => setShowAddNode(true)}>+ Add Node</button>
                </div>
                {showAddNode && (
                    <div className="mb-4 p-4 rounded-xl border border-accent-primary/30 bg-bg-glass">
                        <div className="flex justify-between items-center mb-3">
                            <h4 className="text-sm font-bold">Add Node</h4>
                            <button onClick={() => setShowAddNode(false)} className="text-text-muted cursor-pointer bg-transparent border-none"><IconX size={16} /></button>
                        </div>
                        <FormField label="Workspace Path">
                            <Input
                                value={nodeWorkspace}
                                onChange={e => setNodeWorkspace(e.target.value)}
                                placeholder="/Users/dev/projects/myapp"
                                autoFocus
                            />
                        </FormField>
                        <FormField
                            label="Provider Priority"
                            hint="Order used when launching without an explicit provider. Empty means fail closed unless a provider is selected explicitly."
                        >
                            <Input
                                value={nodeProviderPriority}
                                onChange={e => setNodeProviderPriority(e.target.value)}
                                placeholder="hermes-cli, claude-cli, codex-cli, gemini-cli"
                                onKeyDown={e => { if (e.key === 'Enter') handleAddNode() }}
                            />
                        </FormField>
                        <div className="flex gap-2 mt-3">
                            <button onClick={handleAddNode} disabled={!nodeWorkspace.trim()} className="btn btn-primary btn-sm">Add</button>
                            <button onClick={() => setShowAddNode(false)} className="btn btn-secondary btn-sm">Cancel</button>
                        </div>
                    </div>
                )}

                {selectedMesh.nodes.length === 0 ? (
                    <EmptyState icon={<IconFolder />} title="No nodes" description="Add a workspace to this mesh." />
                ) : (
                    <div className="flex flex-col gap-2">
                        {selectedMesh.nodes.map(node => {
                            const providerPriority = readNodeProviderPriority(node)
                            const priorityStatus = describeNodeProviderPriority(node)
                            return (
                            <div key={node.id} className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-primary">
                                <div>
                                    <div className="text-sm font-medium">{node.workspace.split('/').pop()}</div>
                                    <div className="text-[10px] text-text-muted font-mono">{node.workspace}</div>
                                    <div className="mt-3 max-w-2xl">
                                        <FormField
                                            label="Provider priority"
                                            hint="Used when launches omit an explicit provider. Empty keeps fail-closed behavior until a provider is selected manually."
                                        >
                                            <div className="flex flex-col gap-2 sm:flex-row">
                                                <Input
                                                    value={nodeProviderPriorityDrafts[node.id] ?? providerPriority.join(', ')}
                                                    onChange={e => setNodeProviderPriorityDrafts(prev => ({ ...prev, [node.id]: e.target.value }))}
                                                    placeholder="hermes-cli, claude-cli, codex-cli, gemini-cli"
                                                    onKeyDown={e => { if (e.key === 'Enter') void handleUpdateNodeProviderPriority(node) }}
                                                />
                                                <button
                                                    type="button"
                                                    className="btn btn-secondary btn-sm shrink-0"
                                                    onClick={() => void handleUpdateNodeProviderPriority(node)}
                                                    disabled={savingNodePolicyId === node.id}
                                                >
                                                    {savingNodePolicyId === node.id ? 'Saving...' : 'Save policy'}
                                                </button>
                                            </div>
                                            <div className="mt-2 text-[12px]">
                                                <span className="text-text-muted">Effective provider priority: </span>
                                                <span className={priorityStatus.configured ? 'text-text-primary font-mono' : 'text-amber-400'}>
                                                    {priorityStatus.label}
                                                </span>
                                                {priorityStatus.launchBlockedMessage && (
                                                    <span className="ml-2 text-amber-400">({priorityStatus.launchBlockedMessage})</span>
                                                )}
                                            </div>
                                        </FormField>
                                    </div>
                                </div>
                                <button
                                    className="text-text-muted hover:text-red-400 transition-colors bg-transparent border-none cursor-pointer"
                                    onClick={() => handleRemoveNode(node.id)}
                                >
                                    <IconX size={14} />
                                </button>
                            </div>
                            )
                        })}
                    </div>
                )}
            </Section>

            {/* Hermes MCP config for external coordinator sessions */}
            <RepoMeshHermesMcpConfig
                meshId={selectedMesh.id}
                availableCliAgents={availableCliAgents}
            />
        </AppPage>
    )
}
