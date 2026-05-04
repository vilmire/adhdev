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
}

interface MeshEntry {
    id: string
    name: string
    repoIdentity: string
    repoRemoteUrl?: string
    defaultBranch?: string
    nodes: MeshNode[]
    createdAt: string
    updatedAt: string
}

interface AvailableCliAgent {
    id: string
    name: string
    meshCoordinator?: MeshCoordinatorMetadata
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

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

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
            })
            if (res?.success) {
                setShowAddNode(false)
                setNodeWorkspace('')
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
        try {
            await sendCommand(daemonId, 'remove_mesh_node', { meshId: selectedMeshId, nodeId })
            await loadMeshes()
        } catch (e: any) {
            setError(e?.message || 'Remove node failed')
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
                                onKeyDown={e => { if (e.key === 'Enter') handleAddNode() }}
                                autoFocus
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
                        {selectedMesh.nodes.map(node => (
                            <div key={node.id} className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-primary">
                                <div>
                                    <div className="text-sm font-medium">{node.workspace.split('/').pop()}</div>
                                    <div className="text-[10px] text-text-muted font-mono">{node.workspace}</div>
                                </div>
                                <button
                                    className="text-text-muted hover:text-red-400 transition-colors bg-transparent border-none cursor-pointer"
                                    onClick={() => handleRemoveNode(node.id)}
                                >
                                    <IconX size={14} />
                                </button>
                            </div>
                        ))}
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
