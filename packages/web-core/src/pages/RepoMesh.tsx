/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'

import AppPage from '../components/ui/AppPage'
import { Section } from '../components/ui/Section'
import { EmptyState } from '../components/ui/EmptyState'
import { AlertBanner } from '../components/ui/AlertBanner'
import { FormField, Input } from '../components/ui/FormField'
import { IconX, IconMesh, IconFolder } from '../components/Icons'
import ProviderPriorityEditor from '../components/provider-priority/ProviderPriorityEditor'
import MeshCoordinatorManualSetupPanel from '../components/MeshCoordinatorManualSetupPanel'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    normalizeProviderPriority,
    normalizeProviderPriorityForInventory,
    type AvailableCliProviderOption,
} from '../utils/provider-priority'
import {
    buildManualCoordinatorSetup,
    type MeshCoordinatorMetadata,
} from '../utils/mesh-coordinator-setup'
import { MeshObservabilitySurface } from '../components/MeshGraph'
import { useMeshGraphMetadataSubscription } from '../hooks/useMeshGraphMetadataSubscription'
import {
    useRepoMeshContext,
    type RepoMeshDaemonEntry,
} from '../context/RepoMeshContext'

// ─── Types ───────────────────────────────────────────────────────

export interface MeshNode {
    id: string
    workspace: string
    repoRoot?: string
    providerPriority?: string[]
    policy?: {
        providerPriority?: string[]
        readOnly?: boolean
    }
    isLocalWorktree?: boolean
    worktreeBranch?: string
    clonedFromNodeId?: string
    // cloud-normalized extras (passed through as-is when present)
    [key: string]: any
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
    // cloud extras
    [key: string]: any
}

export interface MeshQueueEntry {
    id: string
    meshId?: string
    message: string
    status: 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled' | string
    targetNodeId?: string
    targetSessionId?: string
    assignedNodeId?: string
    assignedSessionId?: string
    nodeId?: string
    sessionId?: string
    updatedAt?: string
    staleAssigned?: boolean
    staleReason?: string
}

interface MeshQueueSummary {
    active: number
    historical: number
    activeCounts: { pending: number; assigned: number }
    historicalCounts: { completed: number; failed: number }
    counts: { pending: number; assigned: number; completed: number; failed: number }
    staleAssignedCount: number
    recent: MeshQueueEntry[]
}

interface AvailableCliAgent {
    id: string
    name: string
    meshCoordinator?: MeshCoordinatorMetadata
}

type ProviderPriorityDrafts = Record<string, string[]>

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
    allowAutoPublishSubmoduleMainCommits: false,
    requireApprovalForDestructiveGit: true,
    dirtyWorkspaceBehavior: 'warn',
    maxParallelTasks: 2,
    sessionCleanupOnNodeRemove: 'preserve',
}

// ─── Helpers ─────────────────────────────────────────────────────

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

function readMeshPolicy(mesh: MeshEntry | null): Record<string, any> {
    return { ...DEFAULT_MESH_POLICY, ...(mesh?.policy || {}) }
}

function isWorktreeNode(node: MeshNode): boolean {
    return node.isLocalWorktree === true
}

function daemonLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}

function daemonOwnerLabel(daemon: RepoMeshDaemonEntry | undefined, fallback?: string): string {
    return daemon?.ownerName || daemon?.userName || daemon?.user?.name || fallback || 'You'
}

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

// ─── NodeHealthBadge (cloud-style, used in cloud sections) ───────

function NodeHealthBadge({ status }: { status: string }) {
    const config: Record<string, { color: string; label: string }> = {
        online: { color: '#22c55e', label: 'Online' },
        dirty: { color: '#f59e0b', label: 'Dirty' },
        offline: { color: '#6b7280', label: 'Offline' },
        degraded: { color: '#ef4444', label: 'Degraded' },
        enabled: { color: '#22c55e', label: 'Enabled' },
        pending: { color: '#a855f7', label: 'Pending' },
        assigned: { color: '#3b82f6', label: 'Assigned' },
        completed: { color: '#22c55e', label: 'Completed' },
        failed: { color: '#ef4444', label: 'Failed' },
        unknown: { color: '#6b7280', label: 'Unknown' },
    }
    const c = config[status] || { color: '#6b7280', label: status }
    return (
        <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md"
            style={{ background: c.color + '15', color: c.color, border: `1px solid ${c.color}25` }}
        >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
            {c.label}
        </span>
    )
}

function IconRefresh({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
    )
}

function IconGitBranch({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function IconTrash({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function IconPlus({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

// ─── Hermes MCP config panel ──────────────────────────────────────

export function RepoMeshHermesMcpConfig({ meshId, availableCliAgents }: { meshId: string; availableCliAgents: AvailableCliAgent[] }) {
    const hermesAgent = availableCliAgents.find(agent => {
        const id = agent.id.toLowerCase()
        return id === 'hermes-cli' || id.includes('hermes') || agent.name.toLowerCase().includes('hermes')
    })
    const manualSetup = buildManualCoordinatorSetup(hermesAgent?.meshCoordinator, { meshId })
    if (!manualSetup) return null
    return (
        <Section title="Hermes MCP Config" description="Hermes does not auto-import repo-local .mcp.json. Add this YAML under mcp_servers in Hermes config, then start a fresh Hermes session.">
            <MeshCoordinatorManualSetupPanel setup={manualSetup} providerName={hermesAgent?.name || 'Hermes CLI'} />
        </Section>
    )
}

// ─── Main page ───────────────────────────────────────────────────

export default function RepoMesh() {
    const ctx = useRepoMeshContext()
    const { sendCommand, sendData, daemons, userName, loadMeshStatus, launchCoordinator,
        loadLiveMesh, extractStatus, unwrapResult, normalizeMesh,
        resolveCommandTarget, features } = ctx

    // Standalone: first daemon; cloud: selected coordinator daemon
    const primaryDaemon = daemons[0] as RepoMeshDaemonEntry | undefined
    const primaryDaemonId = primaryDaemon?.id || ''

    // Extract available CLI agents + providers from the primary daemon
    const availableCliAgents: AvailableCliAgent[] = useMemo(() => {
        const providers = (primaryDaemon as any)?.availableProviders || []
        return providers
            .filter((p: any) => p.category === 'cli')
            .map((p: any) => ({ id: p.type || p.id, name: p.displayName || p.name || p.type, meshCoordinator: p.meshCoordinator }))
    }, [primaryDaemon])

    const availableCliProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((primaryDaemon as any)?.availableProviders || []),
        [primaryDaemon],
    )

    // ─── State ───

    const [meshes, setMeshes] = useState<MeshEntry[]>([])
    const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [savingPolicy, setSavingPolicy] = useState(false)
    const [savingNodePolicyId, setSavingNodePolicyId] = useState<string | null>(null)
    const [nodeProviderPriorityDrafts, setNodeProviderPriorityDrafts] = useState<ProviderPriorityDrafts>({})
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    // Graph
    const [meshGraphStatus, setMeshGraphStatus] = useState<RepoMeshStatus | null>(null)
    const [graphLoading, setGraphLoading] = useState(false)
    const [graphError, setGraphError] = useState<string | null>(null)
    const [graphProvenance, setGraphProvenance] = useState<'idle' | 'first_paint' | 'settling' | 'settled'>('idle')

    // Queue (shared state; only rendered when features.queueSection)
    const [meshQueue, setMeshQueue] = useState<MeshQueueEntry[]>([])
    const [queueSummary, setQueueSummary] = useState<MeshQueueSummary | null>(null)
    const [queueLoading, setQueueLoading] = useState(false)
    const [queueError, setQueueError] = useState<string | null>(null)

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')
    const [createRepoRemoteUrl, setCreateRepoRemoteUrl] = useState('')

    // Cloud create extras
    const [newMeshDaemonId, setNewMeshDaemonId] = useState('')
    const [newMeshWorkspace, setNewMeshWorkspace] = useState('')

    // Add node form
    const [showAddNode, setShowAddNode] = useState(false)
    const [nodeWorkspace, setNodeWorkspace] = useState('')
    const [nodeProviderPriority, setNodeProviderPriority] = useState<string[]>([])

    // Cloud add-node extras
    const [nodeDaemonId, setNodeDaemonId] = useState('')
    const [nodeCustomPath, setNodeCustomPath] = useState(false)

    // Coordinator (cloud)
    const [coordinatorDaemonId, setCoordinatorDaemonId] = useState('')
    const [coordinatorCliType, setCoordinatorCliType] = useState('')
    const [launchingCoordinator, setLaunchingCoordinator] = useState(false)
    const [launchResult, setLaunchResult] = useState<string | null>(null)

    // Coordinator prompt + node instructions
    const [coordinatorPromptDraft, setCoordinatorPromptDraft] = useState({ override: '', append: '' })
    const [savingCoordinatorPrompt, setSavingCoordinatorPrompt] = useState(false)
    const [nodeSystemPromptDrafts, setNodeSystemPromptDrafts] = useState<Record<string, string>>({})
    const [savingNodeSystemPromptId, setSavingNodeSystemPromptId] = useState<string | null>(null)

    // ─── Derived ─────

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

    // coordinator daemon for cloud; primary for standalone
    const activeDaemonId = features.meshHostDaemonSection
        ? (coordinatorDaemonId || primaryDaemonId)
        : primaryDaemonId

    const activeDaemon = useMemo(
        () => daemons.find(d => d.id === activeDaemonId) || primaryDaemon,
        [daemons, activeDaemonId, primaryDaemon],
    )

    // For cloud daemon picker in add-node form
    const selectedNodeDaemon = useMemo(
        () => daemons.find(d => d.id === nodeDaemonId),
        [daemons, nodeDaemonId],
    )
    const nodePickerWorkspaces = selectedNodeDaemon?.workspaces || []
    const nodePickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedNodeDaemon as any)?.availableProviders || []),
        [selectedNodeDaemon],
    )

    // For cloud daemon picker in create-mesh form
    const selectedCreateDaemon = useMemo(
        () => daemons.find(d => d.id === newMeshDaemonId),
        [daemons, newMeshDaemonId],
    )
    const createPickerWorkspaces = selectedCreateDaemon?.workspaces || []
    const createPickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedCreateDaemon as any)?.availableProviders || []),
        [selectedCreateDaemon],
    )

    const attachedDaemonIds = useMemo(
        () => new Set((selectedMesh?.nodes || []).map(n => String(n.daemon_id || n.daemonId || ''))),
        [selectedMesh],
    )
    const attachableDaemons = useMemo(
        () => daemons.filter(d => d.id && !attachedDaemonIds.has(d.id)),
        [daemons, attachedDaemonIds],
    )

    // live subscription enrichment
    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshGraphStatus,
        daemonId: activeDaemonId || null,
        meshId: selectedMeshId,
        sendData,
    })

    // ─── Effects ─────

    useEffect(() => {
        setNodeProviderPriorityDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, readNodeProviderPriority(node)]),
        ))
    }, [selectedMesh])

    useEffect(() => {
        const coord = (selectedMesh as any)?.coordinator || {}
        setCoordinatorPromptDraft({
            override: typeof coord.systemPromptOverride === 'string' ? coord.systemPromptOverride : '',
            append: typeof coord.systemPromptAppend === 'string' ? coord.systemPromptAppend
                : typeof coord.systemPromptSuffix === 'string' ? coord.systemPromptSuffix : '',
        })
        setNodeSystemPromptDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, typeof (node as any).systemPrompt === 'string' ? (node as any).systemPrompt : '']),
        ))
    }, [selectedMesh])

    useEffect(() => {
        const defaultPriority = features.addNodeDaemonPicker
            ? defaultProviderPriorityFromInventory(nodePickerProviders)
            : defaultProviderPriorityFromInventory(availableCliProviders)
        if (showAddNode && nodeProviderPriority.length === 0 && defaultPriority.length > 0) {
            setNodeProviderPriority(defaultPriority)
        }
    }, [showAddNode, availableCliProviders, nodePickerProviders, nodeProviderPriority.length, features.addNodeDaemonPicker])

    useEffect(() => {
        const nodeIds = new Set((selectedMesh?.nodes || []).map(n => n.id))
        if (selectedNodeId && !nodeIds.has(selectedNodeId)) setSelectedNodeId(null)
    }, [selectedMesh, selectedNodeId])

    // Cloud: init coordinator daemon id from daemons list
    useEffect(() => {
        if (!features.meshHostDaemonSection) return
        if (!daemons.length) { setCoordinatorDaemonId(''); return }
        if (!coordinatorDaemonId || !daemons.some(d => d.id === coordinatorDaemonId)) {
            setCoordinatorDaemonId(daemons[0].id)
        }
    }, [daemons, coordinatorDaemonId, features.meshHostDaemonSection])

    // Cloud: init newMeshDaemonId
    useEffect(() => {
        if (!features.createDaemonPicker) return
        if (!daemons.length) { setNewMeshDaemonId(''); return }
        if (!newMeshDaemonId || !daemons.some(d => d.id === newMeshDaemonId)) {
            setNewMeshDaemonId(daemons[0].id)
        }
    }, [daemons, newMeshDaemonId, features.createDaemonPicker])

    // Cloud: auto-select first workspace when daemon changes in create form
    useEffect(() => {
        if (!features.createDaemonPicker || !newMeshDaemonId) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.length) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.some(w => w.path === newMeshWorkspace)) {
            setNewMeshWorkspace(createPickerWorkspaces[0]?.path || '')
        }
    }, [newMeshDaemonId, newMeshWorkspace, createPickerWorkspaces, features.createDaemonPicker])

    useEffect(() => {
        if (selectedMeshId) {
            setMeshGraphStatus(null)
            setGraphError(null)
            void loadGraph()
        }
    }, [selectedMeshId, activeDaemonId])

    useEffect(() => {
        if (features.queueSection) return // cloud loads queue on demand
        void loadQueue(selectedMeshId)
    }, [selectedMeshId, features.queueSection])

    // ─── Data loading ────────────────────────────────────────────

    const loadMeshes = useCallback(async () => {
        setLoading(true)
        try {
            if (features.createDaemonPicker) {
                // Cloud: load from all daemons in parallel
                const results = await Promise.allSettled(daemons.map(async daemon => {
                    if (!daemon.id) return []
                    const raw = await sendCommand(daemon.id, 'list_meshes', {})
                    const result = unwrapResult(raw)
                    if (result?.success === false) throw new Error(result.error || 'Failed to load meshes')
                    return (Array.isArray(result?.meshes) ? result.meshes : [])
                        .map((m: any) => normalizeMesh(m, daemon.id))
                        .filter((m: any) => m.id)
                }))
                const byId = new Map<string, MeshEntry>()
                for (const r of results) {
                    if (r.status !== 'fulfilled') continue
                    for (const m of r.value) { if (!byId.has(m.id)) byId.set(m.id, m) }
                }
                setMeshes(Array.from(byId.values()))
            } else {
                // Standalone: single daemon
                if (!primaryDaemonId) return
                const res: any = await sendCommand(primaryDaemonId, 'list_meshes')
                if (res?.success) {
                    setMeshes((res.meshes || []).map((m: any) => normalizeMesh(m, primaryDaemonId)))
                    setError(null)
                } else {
                    setError(res?.error || 'Failed to load meshes')
                }
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to load meshes')
        } finally {
            setLoading(false)
        }
    }, [daemons, primaryDaemonId, sendCommand, unwrapResult, normalizeMesh, features.createDaemonPicker])

    const loadQueue = useCallback(async (meshId: string | null) => {
        if (!primaryDaemonId || !meshId) { setMeshQueue([]); return }
        try {
            const res: any = await sendCommand(primaryDaemonId, 'get_mesh_queue', { meshId })
            setMeshQueue(res?.success ? (Array.isArray(res.queue) ? res.queue : []) : [])
        } catch { setMeshQueue([]) }
    }, [primaryDaemonId, sendCommand])

    async function loadGraph(refresh = false) {
        if (!activeDaemonId || !selectedMeshId) return
        try {
            setGraphLoading(!refresh && meshGraphStatus === null)
            setGraphProvenance(refresh ? 'settling' : 'first_paint')
            setGraphError(null)
            const response = await loadMeshStatus(activeDaemonId, selectedMeshId, {
                refresh,
                retryProfile: refresh ? 'settled' : 'interactive',
            })
            const status = extractStatus(response)
            if (status) {
                setMeshGraphStatus(status)
                setGraphProvenance('settled')
            } else {
                setMeshGraphStatus(null)
                setGraphError('mesh_status returned an unexpected payload.')
                setGraphProvenance('idle')
            }
        } catch (e: any) {
            if (!meshGraphStatus) setMeshGraphStatus(null)
            setGraphError(e?.message || 'Failed to load mesh graph')
            setGraphProvenance('idle')
        } finally {
            setGraphLoading(false)
        }
    }

    async function handleLoadQueue() {
        if (!selectedMesh) return
        setQueueLoading(true)
        setQueueError(null)
        try {
            const liveMesh = loadLiveMesh
                ? await loadLiveMesh(activeDaemonId, selectedMesh.id, selectedMesh)
                : null
            const target = resolveCommandTarget(activeDaemonId, selectedMesh.id, selectedMesh, selectedMesh.nodes || [], liveMesh)
            if ('error' in target) throw new Error(target.error)
            const raw = await sendCommand(target.targetDaemonId, 'get_mesh_queue', { meshId: selectedMesh.id })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Queue load failed')
            const queue: MeshQueueEntry[] = Array.isArray(result?.result?.rows ?? result?.rows ?? result?.queue)
                ? (result?.result?.rows ?? result?.rows ?? result?.queue)
                : []
            setQueueSummary(buildQueueSummary(queue))
        } catch (e: any) {
            setQueueError(e?.message || 'Queue load failed')
        } finally {
            setQueueLoading(false)
        }
    }

    useEffect(() => { void loadMeshes() }, [loadMeshes])

    // ─── Actions ─────────────────────────────────────────────────

    async function handleCreate() {
        const targetDaemonId = features.createDaemonPicker ? newMeshDaemonId : primaryDaemonId
        if (!targetDaemonId || !createName.trim()) return
        const remoteUrl = createRepoRemoteUrl.trim()
        const identity = createRepoIdentity.trim()
        if (!remoteUrl && !identity) return
        try {
            const payload: any = { name: createName.trim() }
            if (remoteUrl) payload.repoRemoteUrl = remoteUrl
            if (identity) payload.repoIdentity = identity
            if (features.createDaemonPicker && newMeshWorkspace) {
                // cloud: attach first node in same call after create
            }
            const raw = await sendCommand(targetDaemonId, 'create_mesh', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Create failed')
            const meshId = typeof result?.mesh?.id === 'string' ? result.mesh.id : ''
            if (meshId && features.createDaemonPicker && newMeshWorkspace) {
                const addRaw = await sendCommand(targetDaemonId, 'add_mesh_node', {
                    meshId,
                    daemonId: targetDaemonId,
                    machineId: selectedCreateDaemon?.machineId,
                    workspace: newMeshWorkspace,
                    role: 'host',
                    providerPriority: defaultProviderPriorityFromInventory(createPickerProviders),
                })
                const addResult = unwrapResult(addRaw)
                if (addResult?.success === false) throw new Error(addResult.error || 'Mesh created but failed to attach workspace')
            }
            setShowCreate(false); setCreateName(''); setCreateRepoIdentity(''); setCreateRepoRemoteUrl(''); setNewMeshWorkspace('')
            await loadMeshes()
            if (result?.mesh?.id) setSelectedMeshId(result.mesh.id)
        } catch (e: any) { setError(e?.message || 'Create failed') }
    }

    async function handleDelete(meshId: string) {
        if (!confirm('Delete this mesh? This cannot be undone.')) return
        const targetDaemonId = (meshes.find(m => m.id === meshId) as any)?.__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'delete_mesh', { meshId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to delete')
            if (selectedMeshId === meshId) { setSelectedMeshId(null); setMeshGraphStatus(null) }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Delete failed') }
    }

    async function handleAddNode() {
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        if (!selectedMeshId || !targetDaemonId) return
        const ws = nodeWorkspace.trim()
        if (!ws) return
        try {
            const payload: any = { meshId: selectedMeshId, workspace: ws }
            if (features.addNodeDaemonPicker && nodeDaemonId) {
                payload.daemonId = nodeDaemonId
                payload.machineId = selectedNodeDaemon?.machineId
                payload.providerPriority = normalizeProviderPriorityForInventory(nodeProviderPriority, nodePickerProviders)
            } else {
                payload.providerPriority = normalizeProviderPriorityForInventory(nodeProviderPriority, availableCliProviders)
            }
            const raw = await sendCommand(targetDaemonId, 'add_mesh_node', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Add node failed')
            setShowAddNode(false); setNodeWorkspace(''); setNodeProviderPriority([]); setNodeDaemonId(''); setNodeCustomPath(false)
            await loadMeshes()
            if (!features.queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Add node failed') }
    }

    async function handleRemoveNode(nodeId: string) {
        if (!selectedMesh) return
        const policy = readMeshPolicy(selectedMesh)
        const cleanupLabel = SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove)?.label || 'Preserve history and runtimes'
        if (!confirm(`Remove this node?\n\nNode removal cleanup policy: ${cleanupLabel}`)) return
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'remove_mesh_node', { meshId: selectedMesh.id, nodeId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Remove failed')
            if (selectedNodeId === nodeId) setSelectedNodeId(null)
            await loadMeshes()
            if (!features.queueSection) await loadQueue(selectedMeshId)
        } catch (e: any) { setError(e?.message || 'Remove node failed') }
    }

    async function handleUpdatePolicy(patch: Record<string, unknown>) {
        if (!selectedMesh) return
        const nextPolicy = { ...readMeshPolicy(selectedMesh), ...patch }
        const targetDaemonId = (selectedMesh as any).__sourceDaemonId || primaryDaemonId
        try {
            setSavingPolicy(true); setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh', { meshId: selectedMesh.id, policy: nextPolicy })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Policy update failed')
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Policy update failed') }
        finally { setSavingPolicy(false) }
    }

    async function handleSaveCoordinatorPrompt() {
        if (!primaryDaemonId || !selectedMeshId) return
        const existingCoord = ((selectedMesh as any)?.coordinator || {}) as Record<string, unknown>
        const nextCoord: Record<string, unknown> = { ...existingCoord }
        if (coordinatorPromptDraft.override.trim()) nextCoord.systemPromptOverride = coordinatorPromptDraft.override
        else delete nextCoord.systemPromptOverride
        if (coordinatorPromptDraft.append.trim()) nextCoord.systemPromptAppend = coordinatorPromptDraft.append
        else delete nextCoord.systemPromptAppend
        delete nextCoord.systemPromptSuffix
        try {
            setSavingCoordinatorPrompt(true); setError(null)
            const raw = await sendCommand(primaryDaemonId, 'update_mesh', { meshId: selectedMeshId, coordinator: nextCoord })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Coordinator prompt save failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Coordinator prompt save failed') }
        finally { setSavingCoordinatorPrompt(false) }
    }

    async function handleSaveNodeSystemPrompt(node: MeshNode) {
        if (!primaryDaemonId || !selectedMeshId) return
        const next = (nodeSystemPromptDrafts[node.id] || '').trim()
        try {
            setSavingNodeSystemPromptId(node.id); setError(null)
            const raw = await sendCommand(primaryDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, systemPrompt: next })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node instruction save failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node instruction save failed') }
        finally { setSavingNodeSystemPromptId(null) }
    }

    async function handleUpdateNodeProviderPriority(node: MeshNode) {
        if (!selectedMeshId) return
        const targetDaemonId = (selectedMesh as any)?.__sourceDaemonId || primaryDaemonId
        const providers = features.addNodeDaemonPicker ? nodePickerProviders : availableCliProviders
        const requested = nodeProviderPriorityDrafts[node.id] || readNodeProviderPriority(node)
        const providerPriority = providers.length > 0
            ? normalizeProviderPriorityForInventory(requested, providers)
            : normalizeProviderPriority(requested)
        const nextPolicy = { ...(node.policy || {}) }
        delete (nextPolicy as any).provider_priority
        if (providerPriority.length) nextPolicy.providerPriority = providerPriority
        else delete nextPolicy.providerPriority
        try {
            setSavingNodePolicyId(node.id); setError(null)
            const raw = await sendCommand(targetDaemonId, 'update_mesh_node', { meshId: selectedMeshId, nodeId: node.id, policy: nextPolicy, providerPriority })
            const result = unwrapResult(raw)
            if (result?.success === false) { setError(result.error || 'Node policy update failed'); return }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Node policy update failed') }
        finally { setSavingNodePolicyId(null) }
    }

    async function handleLaunchCoordinator() {
        if (!selectedMesh) return
        setError(null); setLaunchResult(null)
        try {
            setLaunchingCoordinator(true)
            const liveMesh = loadLiveMesh ? await loadLiveMesh(activeDaemonId, selectedMesh.id, selectedMesh) : null
            const target = resolveCommandTarget(activeDaemonId, selectedMesh.id, selectedMesh, selectedMesh.nodes || [], liveMesh)
            if ('error' in target) throw new Error(target.error)
            const result = await launchCoordinator(target.targetDaemonId, {
                meshId: selectedMesh.id,
                inlineMesh: target.inlineMesh,
                coordinatorNodeId: target.coordinatorNodeId,
                cliType: coordinatorCliType.trim() || undefined,
            })
            setLaunchResult(result.message)
        } catch (e: any) { setError(e?.message || 'Coordinator launch failed') }
        finally { setLaunchingCoordinator(false) }
    }

    // ─── Render helpers ───────────────────────────────────────────

    if (!primaryDaemonId) {
        return (
            <AppPage icon={<IconMesh />} title="Repo Mesh" subtitle="Multi-workspace orchestration">
                <div className="text-sm text-text-muted p-4">Waiting for daemon connection...</div>
            </AppPage>
        )
    }

    // ─── List view ────────────────────────────────────────────────

    if (!selectedMesh) {
        return (
            <AppPage
                icon={<IconMesh />}
                title="Repo Meshes"
                subtitle={`${meshes.length} mesh${meshes.length !== 1 ? 'es' : ''}`}
                widthClassName="max-w-5xl"
                actions={<button className="btn btn-primary btn-sm" onClick={() => setShowCreate(!showCreate)}>+ Create Mesh</button>}
            >
                {error && <AlertBanner variant="error" onDismiss={() => setError(null)} className="mb-4">{error}</AlertBanner>}

                {showCreate && (
                    <Section className="mb-5 border-accent/40 animate-[fadeIn_0.3s_ease-out]">
                        <h3 className="text-base font-bold mb-4">Create Repo Mesh</h3>

                        {features.createDaemonPicker && (
                            <FormField label="Create on machine" hint="Mesh setup is stored by the selected daemon.">
                                <select className="input w-full" value={newMeshDaemonId} onChange={e => setNewMeshDaemonId(e.target.value)} disabled={!daemons.length}>
                                    {daemons.length === 0
                                        ? <option value="">No connected daemon</option>
                                        : daemons.map(d => <option key={d.id} value={d.id}>{daemonLabel(d)}</option>)}
                                </select>
                            </FormField>
                        )}

                        {features.createDaemonPicker && (
                            <FormField label="Workspace" hint="Choose from workspaces registered by the selected daemon.">
                                <select className="input w-full" value={newMeshWorkspace} onChange={e => setNewMeshWorkspace(e.target.value)} disabled={!newMeshDaemonId || !createPickerWorkspaces.length}>
                                    {!newMeshDaemonId ? <option value="">Select a machine first</option>
                                        : createPickerWorkspaces.length === 0 ? <option value="">No registered workspaces</option>
                                        : createPickerWorkspaces.map(w => (
                                            <option key={w.id || w.path} value={w.path}>
                                                {w.label ? `${w.label} · ${w.path}` : w.path}
                                            </option>
                                        ))}
                                </select>
                            </FormField>
                        )}

                        <FormField label="Name">
                            <Input value={createName} onChange={e => setCreateName(e.target.value)} placeholder="my-project-mesh" autoFocus />
                        </FormField>
                        <FormField label="Repo remote URL (optional)" hint="Provide a remote URL OR a stable identity.">
                            <Input value={createRepoRemoteUrl} onChange={e => setCreateRepoRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo" />
                        </FormField>
                        <FormField label="Repo identity (optional)" hint="Provide a remote URL OR a stable identity.">
                            <Input value={createRepoIdentity} onChange={e => setCreateRepoIdentity(e.target.value)} placeholder="github.com/user/repo" />
                        </FormField>

                        <div className="flex gap-2 mt-3">
                            <button className="btn btn-primary btn-sm" onClick={handleCreate}
                                disabled={!createName.trim() || (!createRepoRemoteUrl.trim() && !createRepoIdentity.trim()) || (features.createDaemonPicker && (!newMeshDaemonId || !newMeshWorkspace))}>
                                Create
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => { setShowCreate(false); setCreateName(''); setCreateRepoIdentity(''); setCreateRepoRemoteUrl('') }}>Cancel</button>
                        </div>
                    </Section>
                )}

                {loading ? (
                    <div className="text-sm text-text-muted p-4">Loading meshes...</div>
                ) : meshes.length === 0 ? (
                    <EmptyState icon={<IconMesh />} title="No Repo Meshes"
                        description={daemons.length > 0 ? 'Create a mesh to get started.' : 'Connect an ADHDev daemon first.'}
                        action={<button className="btn btn-primary btn-sm" disabled={!daemons.length} onClick={() => setShowCreate(true)}>Create First Mesh</button>} />
                ) : (
                    <div className="flex flex-col gap-2.5">
                        {meshes.map(mesh => (
                            <button key={mesh.id} type="button" onClick={() => setSelectedMeshId(mesh.id)}
                                className="w-full text-left bg-bg-glass border border-border-subtle rounded-xl px-5 py-4 transition-colors hover:border-border-default hover:bg-bg-secondary/70">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <IconMesh size={16} />
                                            <span className="font-bold text-sm">{mesh.name}</span>
                                        </div>
                                        <div className="text-[12px] text-text-muted flex items-center gap-2">
                                            <span className="font-mono">{mesh.repoIdentity || (mesh as any).repo_identity || 'No repo identity'}</span>
                                            {(mesh.defaultBranch || (mesh as any).default_branch) && (
                                                <span className="inline-flex items-center gap-1"><IconGitBranch size={11} />{mesh.defaultBranch || (mesh as any).default_branch}</span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right text-[11px] text-text-muted shrink-0 ml-4">
                                        <div>{new Date(mesh.createdAt || (mesh as any).created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                                        <div className="text-text-muted/60">{mesh.nodes?.length ?? (mesh as any).nodeCount ?? 0} node(s)</div>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </AppPage>
        )
    }

    // ─── Detail view ──────────────────────────────────────────────

    const policy = readMeshPolicy(selectedMesh)

    // Cloud: nodes as MeshNode (already normalized by context)
    const nodes: MeshNode[] = selectedMesh.nodes || []

    // Cloud: attached/attachable daemons for node inventory section
    const selectedHostNode = useMemo(
        () => nodes.find(n => String(n.daemon_id || n.daemonId || '') === coordinatorDaemonId),
        [nodes, coordinatorDaemonId],
    )
    const isHostNodeAttached = features.meshHostDaemonSection ? !!selectedHostNode : true

    return (
        <AppPage
            icon={<IconMesh />}
            title={selectedMesh.name}
            subtitle={selectedMesh.repoIdentity || (selectedMesh as any).repo_identity || 'Repo Mesh'}
            widthClassName="max-w-5xl"
            actions={
                <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={() => { setSelectedMeshId(null); setMeshGraphStatus(null) }}>← Back</button>
                    <button className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => loadGraph(true)} disabled={graphLoading}>
                        <IconRefresh size={13} />{graphLoading ? 'Probing...' : 'Refresh'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selectedMesh.id)}>Delete</button>
                </div>
            }
        >
            {error && <AlertBanner variant="error" onDismiss={() => setError(null)} className="mb-4">{error}</AlertBanner>}

            {/* ── Policy ── */}
            <Section title="Policy" description="Coordinator safety defaults and session cleanup behavior.">
                <div className="grid gap-4 sm:grid-cols-2">
                    {[
                        { label: 'Checkpoint before task', key: 'requirePreTaskCheckpoint', opts: [['no', 'No'], ['yes', 'Yes']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: 'Checkpoint after task', key: 'requirePostTaskCheckpoint', opts: [['yes', 'Yes'], ['no', 'No']], val: (v: any) => v ? 'yes' : 'no', parse: (v: string) => v === 'yes' },
                        { label: 'Push approval', key: 'requireApprovalForPush', opts: [['required', 'Require approval before push'], ['not_required', 'Do not require approval']], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: 'Submodule main auto-publish', key: 'allowAutoPublishSubmoduleMainCommits', opts: [['disabled', 'Require explicit approval'], ['enabled', 'Allow Refinery non-force publish']], val: (v: any) => v ? 'enabled' : 'disabled', parse: (v: string) => v === 'enabled' },
                        { label: 'Destructive git approval', key: 'requireApprovalForDestructiveGit', opts: [['required', 'Require approval'], ['not_required', 'Do not require approval']], val: (v: any) => v ? 'required' : 'not_required', parse: (v: string) => v === 'required' },
                        { label: 'Dirty workspace behavior', key: 'dirtyWorkspaceBehavior', opts: [['warn', 'Warn and continue'], ['block', 'Block task'], ['checkpoint_then_continue', 'Checkpoint then continue']], val: (v: any) => v || 'warn', parse: (v: string) => v },
                    ].map(({ label, key, opts, val, parse }) => (
                        <FormField key={key} label={label}>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={val(policy[key])} onChange={e => handleUpdatePolicy({ [key]: parse(e.target.value) })} disabled={savingPolicy}>
                                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                        </FormField>
                    ))}
                    <FormField label="Max parallel tasks">
                        <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={String(policy.maxParallelTasks ?? 2)} onChange={e => handleUpdatePolicy({ maxParallelTasks: Number(e.target.value) })} disabled={savingPolicy}>
                            {[1, 2, 3, 4, 5, 6, 7, 8].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                    </FormField>
                </div>
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                    <FormField label="Node removal session cleanup" hint="Separate transcript cleanup from runtime/process cleanup.">
                        <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                            value={policy.sessionCleanupOnNodeRemove || 'preserve'} onChange={e => handleUpdatePolicy({ sessionCleanupOnNodeRemove: e.target.value })} disabled={savingPolicy}>
                            {SESSION_CLEANUP_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                    </FormField>
                    <div className="mt-2 text-[12px] text-text-muted">
                        {SESSION_CLEANUP_MODE_OPTIONS.find(o => o.value === policy.sessionCleanupOnNodeRemove)?.description || SESSION_CLEANUP_MODE_OPTIONS[0].description}
                    </div>
                </div>
                {savingPolicy && <div className="mt-3 text-[12px] text-text-muted">Saving policy...</div>}
            </Section>

            {/* ── Standalone: Coordinator prompt ── */}
            {features.coordinatorPrompt && (
                <Section title="Coordinator prompt"
                    description="Customize the system prompt for coordinator sessions. Supports placeholders: {{meshName}}, {{repo}}, {{defaultBranch}}, {{cliType}}, {{nodes}}, {{policy}}, {{tools}}, {{workflow}}, {{rules}}, {{toolExposurePreflight}}.">
                    <FormField label="Override (replaces default)" hint="When set, replaces the daemon's default base prompt. Leave empty to keep the default.">
                        <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                            rows={6} value={coordinatorPromptDraft.override}
                            onChange={e => setCoordinatorPromptDraft(d => ({ ...d, override: e.target.value }))}
                            disabled={savingCoordinatorPrompt} placeholder="(empty — daemon default applies)" />
                    </FormField>
                    <FormField label="Append (added after the base)" hint="Always added after whichever base prompt wins.">
                        <textarea className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary font-mono"
                            rows={4} value={coordinatorPromptDraft.append}
                            onChange={e => setCoordinatorPromptDraft(d => ({ ...d, append: e.target.value }))}
                            disabled={savingCoordinatorPrompt} placeholder="(empty — nothing appended)" />
                    </FormField>
                    <div className="mt-3 flex items-center gap-2">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveCoordinatorPrompt()} disabled={savingCoordinatorPrompt}>
                            {savingCoordinatorPrompt ? 'Saving…' : 'Save coordinator prompt'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCoordinatorPromptDraft({ override: '', append: '' })} disabled={savingCoordinatorPrompt} title="Clear both fields. Click Save to commit.">Clear</button>
                    </div>
                </Section>
            )}

            {/* ── Cloud: Mesh Host daemon section ── */}
            {features.meshHostDaemonSection && (
                <Section title="Mesh Host daemon" description="Choose the daemon that will own the coordinator. Host-owned live truth is required before cloud renders status, queue, graph, or node detail.">
                    <AlertBanner variant="info" className="mb-4">
                        <strong>Start with one host workspace.</strong>{' '}
                        Create a mesh on a connected daemon, then attach additional machine workspaces below. Live status, queue, and graph data come from the selected host daemon.
                    </AlertBanner>
                    <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] items-end">
                        <FormField label="Mesh Host daemon" hint="Cloud selects the connected daemon to command over P2P; the host must be attached before it can own a coordinator.">
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={coordinatorDaemonId} onChange={e => { setCoordinatorDaemonId(e.target.value); setMeshGraphStatus(null) }}>
                                <option value="">Select a Mesh Host...</option>
                                {daemons.map(d => (
                                    <option key={d.id} value={d.id}>
                                        {daemonLabel(d)} · {attachedDaemonIds.has(d.id) ? 'attached' : 'not attached'}
                                    </option>
                                ))}
                            </select>
                        </FormField>
                        <FormField label="CLI provider">
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                value={coordinatorCliType} onChange={e => setCoordinatorCliType(e.target.value)}>
                                <option value="">Use node provider priority</option>
                                <option value="claude-cli">Claude Code</option>
                                <option value="codex-cli">Codex</option>
                                <option value="gemini-cli">Gemini</option>
                                <option value="hermes-cli">Hermes</option>
                            </select>
                        </FormField>
                        <button className="btn btn-primary btn-sm" onClick={handleLaunchCoordinator}
                            disabled={!coordinatorDaemonId || !isHostNodeAttached || launchingCoordinator}
                            title={!isHostNodeAttached && coordinatorDaemonId ? 'Attach this Mesh Host daemon first.' : undefined}>
                            {launchingCoordinator ? 'Launching...' : 'Launch Host Coordinator'}
                        </button>
                    </div>
                    <div className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-[12px] text-text-muted">
                        {coordinatorDaemonId
                            ? isHostNodeAttached
                                ? <>Host setup node: <span className="font-mono text-text-primary">{selectedHostNode?.workspace}</span>. Live graph/status/detail renders only from this daemon.</>
                                : <>Selected host is not attached yet. Attach one of its workspaces below before launching.</>
                            : 'Select a connected daemon to become the Mesh Host.'}
                    </div>
                    {!isHostNodeAttached && coordinatorDaemonId && (
                        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => { setNodeDaemonId(coordinatorDaemonId); setShowAddNode(true) }}>
                            Attach selected host daemon
                        </button>
                    )}
                    {launchResult && (
                        <div className="mt-3 text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{launchResult}</div>
                    )}
                </Section>
            )}

            {/* ── Cloud: Queue section ── */}
            {features.queueSection && (
                <Section title="Queue" description="Inspect active queue work separately from historical completed, failed, and cancelled task records.">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 flex-1 min-w-[260px]">
                            {[
                                ['Active', queueSummary?.active ?? 0, 'text-accent-primary'],
                                ['Pending', queueSummary?.activeCounts.pending ?? queueSummary?.counts.pending ?? 0, 'text-text-primary'],
                                ['Assigned', queueSummary?.activeCounts.assigned ?? queueSummary?.counts.assigned ?? 0, 'text-blue-400'],
                                ['Stale', queueSummary?.staleAssignedCount ?? 0, 'text-amber-400'],
                                ['Historical', queueSummary?.historical ?? 0, 'text-text-muted'],
                                ['Completed', queueSummary?.historicalCounts.completed ?? queueSummary?.counts.completed ?? 0, 'text-green-400'],
                                ['Failed', queueSummary?.historicalCounts.failed ?? queueSummary?.counts.failed ?? 0, 'text-red-400'],
                            ].map(([label, value, color]) => (
                                <div key={String(label)} className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                                    <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
                                    <div className={`text-lg font-bold ${color}`}>{value}</div>
                                </div>
                            ))}
                        </div>
                        <button type="button" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={handleLoadQueue} disabled={queueLoading || !activeDaemonId}>
                            <IconRefresh size={13} />{queueLoading ? 'Loading...' : 'Refresh Queue'}
                        </button>
                    </div>
                    {queueError && <div className="mb-3 text-[12px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">{queueError}</div>}
                    {!queueSummary ? (
                        <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">
                            Refresh the queue to view host-owned task counts and recent assignments.
                        </div>
                    ) : queueSummary.recent.length === 0 ? (
                        <div className="text-[12px] text-text-muted rounded-lg border border-border-subtle bg-bg-secondary px-3 py-3">Queue is empty.</div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {queueSummary.recent.map(item => (
                                <div key={item.id} className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="font-mono text-[11px] text-text-muted">{item.id.slice(0, 12)}</span>
                                                <NodeHealthBadge status={item.status} />
                                                {item.staleAssigned && (
                                                    <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5" title={item.staleReason || 'Stale assignment'}>stale</span>
                                                )}
                                            </div>
                                            {item.message && <div className="text-[12px] text-text-primary truncate">{item.message}</div>}
                                        </div>
                                        <div className="text-right text-[10px] text-text-muted shrink-0">
                                            {item.nodeId && <div>node {item.nodeId.slice(0, 10)}</div>}
                                            {item.sessionId && <div>session {item.sessionId.slice(0, 10)}</div>}
                                            {item.updatedAt && <div>{new Date(item.updatedAt).toLocaleTimeString()}</div>}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Section>
            )}

            {/* ── Graph / Visualization ── */}
            <Section title="Visualization" description="Live mesh topology: branches, worktrees, sessions, and orphan detection.">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[12px] text-text-muted max-w-2xl">
                        {features.meshHostDaemonSection
                            ? <>Direct aggregate mesh_status from the selected Mesh Host is preferred. Refresh asks the host for the latest peer git provenance.{graphProvenance === 'settling' && <span className="ml-1 text-amber-300">Refreshing peer provenance...</span>}</>
                            : <div className="flex items-center gap-3">
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />healthy</span>
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />dirty</span>
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />error</span>
                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-500" />offline</span>
                            </div>
                        }
                    </div>
                    <button type="button" className="btn btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => loadGraph(true)} disabled={graphLoading || (features.meshHostDaemonSection && !activeDaemonId)}>
                        <IconRefresh size={13} />{graphLoading ? 'Loading...' : 'Refresh Graph'}
                    </button>
                </div>
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
                    />
                )}
            </Section>

            {/* ── Nodes ── */}
            <Section
                title={features.meshHostDaemonSection ? `Attached machine daemons (${nodes.length})` : 'Nodes'}
                description={features.meshHostDaemonSection
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
                                        onClick={() => { setNodeDaemonId(d.id); setNodeWorkspace(''); setNodeCustomPath(false); setNodeProviderPriority(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((d as any).availableProviders || []))); setShowAddNode(true) }}>
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
                    <button className="btn btn-primary btn-sm mb-4 inline-flex items-center gap-1.5" onClick={() => setShowAddNode(true)}>
                        <IconPlus size={13} /> {features.addNodeDaemonPicker ? 'Attach Machine Daemon' : '+ Add Node'}
                    </button>
                )}

                {/* Add node form */}
                {showAddNode && (
                    <div className="mb-4 p-4 rounded-xl border border-accent-primary/30 bg-bg-glass animate-[fadeIn_0.3s_ease-out]">
                        <div className="flex justify-between items-center mb-3">
                            <h4 className="text-sm font-bold">{features.addNodeDaemonPicker ? 'Attach Machine Daemon' : 'Add Node'}</h4>
                            <button onClick={() => { setShowAddNode(false); setNodeDaemonId(''); setNodeCustomPath(false) }} className="text-text-muted cursor-pointer bg-transparent border-none"><IconX size={16} /></button>
                        </div>

                        {/* Cloud: machine picker */}
                        {features.addNodeDaemonPicker && (
                            <FormField label="Machine">
                                <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary"
                                    value={nodeDaemonId} onChange={e => { setNodeDaemonId(e.target.value); setNodeWorkspace(''); setNodeCustomPath(false); setNodeProviderPriority(defaultProviderPriorityFromInventory(normalizeAvailableCliProviders((daemons.find(d => d.id === e.target.value) as any)?.availableProviders || []))) }}>
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
                                                    onClick={() => setNodeWorkspace(w.path)}>
                                                    <span className="font-medium block truncate">{w.label || w.path.split('/').pop()}</span>
                                                    <span className="text-[10px] text-text-muted font-mono truncate block">{w.path}</span>
                                                </button>
                                            ))}
                                        </div>
                                        <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0" onClick={() => { setNodeCustomPath(true); setNodeWorkspace('') }}>Or enter a custom path →</button>
                                    </>
                                ) : (
                                    <>
                                        {!features.addNodeDaemonPicker ? (
                                            (() => {
                                                const knownWorkspaces: Array<{ id?: string; path: string; label?: string | null }> = Array.isArray((activeDaemon as any)?.workspaces) ? (activeDaemon as any).workspaces : []
                                                const datalistId = `mesh-add-node-workspaces-${selectedMeshId || 'new'}`
                                                return (
                                                    <>
                                                        <Input value={nodeWorkspace} onChange={e => setNodeWorkspace(e.target.value)} placeholder={knownWorkspaces[0]?.path || '/Users/dev/projects/myapp'}
                                                            list={knownWorkspaces.length > 0 ? datalistId : undefined} autoFocus />
                                                        {knownWorkspaces.length > 0 && (
                                                            <>
                                                                <datalist id={datalistId}>{knownWorkspaces.map(w => <option key={w.id || w.path} value={w.path}>{w.label || w.path}</option>)}</datalist>
                                                                <div className="mt-2 flex flex-wrap gap-1.5">
                                                                    {knownWorkspaces.slice(0, 6).map(w => (
                                                                        <button key={w.id || w.path} type="button" onClick={() => setNodeWorkspace(w.path)}
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
                                                <Input value={nodeWorkspace} onChange={e => setNodeWorkspace(e.target.value)} placeholder="/Users/dev/projects/myapp" onKeyDown={e => { if (e.key === 'Enter') handleAddNode() }} />
                                                {nodePickerWorkspaces.length > 0 && (
                                                    <button type="button" className="text-[11px] text-accent-primary bg-transparent border-none cursor-pointer p-0 mt-1" onClick={() => { setNodeCustomPath(false); setNodeWorkspace('') }}>← Pick from saved workspaces</button>
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
                                onChange={setNodeProviderPriority}
                            />
                        </FormField>

                        <div className="flex gap-2 mt-3">
                            <button onClick={handleAddNode} disabled={!nodeWorkspace.trim() || (features.addNodeDaemonPicker && !nodeDaemonId)} className="btn btn-primary btn-sm">Add</button>
                            <button onClick={() => { setShowAddNode(false); setNodeDaemonId(''); setNodeCustomPath(false) }} className="btn btn-secondary btn-sm">Cancel</button>
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
                                    onClick={!features.addNodeDaemonPicker ? () => setSelectedNodeId(isSelected ? null : node.id) : undefined}
                                    onKeyDown={!features.addNodeDaemonPicker ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedNodeId(isSelected ? null : node.id) } } : undefined}
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
                                                        onChange={next => setNodeProviderPriorityDrafts(prev => ({ ...prev, [node.id]: next }))}
                                                        disabled={savingNodePolicyId === node.id}
                                                        saveButton={(
                                                            <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                                onClick={e => { e.stopPropagation(); void handleUpdateNodeProviderPriority(node) }}
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
                                                            onChange={e => { const next = e.target.value; setNodeSystemPromptDrafts(prev => ({ ...prev, [node.id]: next })) }}
                                                            onClick={e => e.stopPropagation()}
                                                            disabled={savingNodeSystemPromptId === node.id}
                                                            placeholder="e.g. 'Run only smoke tests here', 'Use opus on this node'" />
                                                        <div className="mt-2 flex items-center gap-2">
                                                            <button type="button" className="btn btn-secondary btn-sm shrink-0"
                                                                onClick={e => { e.stopPropagation(); void handleSaveNodeSystemPrompt(node) }}
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
                                            onClick={e => { e.stopPropagation(); void handleRemoveNode(node.id) }}
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

            {/* ── Standalone: Hermes MCP config ── */}
            {features.hermesMcpConfig && (
                <RepoMeshHermesMcpConfig meshId={selectedMesh.id} availableCliAgents={availableCliAgents} />
            )}

            {/* ── Cloud: MCP hint ── */}
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

// ─── Queue summary builder ────────────────────────────────────────

function buildQueueSummary(queue: MeshQueueEntry[]): MeshQueueSummary {
    const active = queue.filter(t => t.status === 'pending' || t.status === 'assigned')
    const historical = queue.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    return {
        active: active.length,
        historical: historical.length,
        activeCounts: { pending: active.filter(t => t.status === 'pending').length, assigned: active.filter(t => t.status === 'assigned').length },
        historicalCounts: { completed: historical.filter(t => t.status === 'completed').length, failed: historical.filter(t => t.status === 'failed').length },
        counts: {
            pending: queue.filter(t => t.status === 'pending').length,
            assigned: queue.filter(t => t.status === 'assigned').length,
            completed: queue.filter(t => t.status === 'completed').length,
            failed: queue.filter(t => t.status === 'failed').length,
        },
        staleAssignedCount: queue.filter(t => t.staleAssigned).length,
        recent: queue.slice(0, 20),
    }
}
