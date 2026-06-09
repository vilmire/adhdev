/**
 * RepoMeshContext
 *
 * Injects platform-specific behaviour into the shared RepoMesh page.
 *
 * Standalone: useTransport() + useBaseDaemons() provide the defaults.
 * Cloud:      web-cloud wraps the page with a provider that supplies
 *             multi-daemon loading, cloud retry logic, and cloud-only UI.
 */
import { createContext, useContext } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'

// ─── Daemon entry (common subset used by the page) ──────────────

export interface RepoMeshDaemonEntry {
    id: string
    machineNickname?: string
    nickname?: string
    hostname?: string
    machineId?: string
    ownerName?: string
    userName?: string
    user?: { name?: string }
    workspaces?: Array<{ id?: string; path: string; label?: string | null }>
    availableProviders?: any[]
    status?: string
    platform?: string
}

// ─── Mesh status load options ────────────────────────────────────

export interface LoadMeshStatusOptions {
    refresh?: boolean
    retryProfile?: 'interactive' | 'settled'
}

// ─── Coordinator launch params ───────────────────────────────────

export interface LaunchCoordinatorParams {
    meshId: string
    /** Cloud: pre-built inline mesh payload; standalone: omitted */
    inlineMesh?: any
    coordinatorNodeId?: string
    cliType?: string
}

export interface LaunchCoordinatorResult {
    sessionId?: string
    message: string
}

// ─── Feature flags ───────────────────────────────────────────────

export interface RepoMeshFeatures {
    /** Show "Mesh Host daemon" section with multi-daemon coordinator picker (cloud) */
    meshHostDaemonSection: boolean
    /** Show queue summary + recent tasks section (cloud) */
    queueSection: boolean
    /** Show daemon machine picker in "Create Mesh" form (cloud) */
    createDaemonPicker: boolean
    /** Show daemon machine picker in "Add Node" form (cloud) */
    addNodeDaemonPicker: boolean
    /** Show "Coordinator prompt" override/append section (standalone) */
    coordinatorPrompt: boolean
    /** Show per-node "Node instruction" textarea (standalone) */
    nodeInstruction: boolean
    /** Show "Hermes MCP config" section (standalone) */
    hermesMcpConfig: boolean
    /** Show "Mesh Host pairing" section (standalone multi-machine) */
    hostPairing: boolean
}

// ─── Context value ───────────────────────────────────────────────

export interface RepoMeshContextValue {
    // Transport
    sendCommand: (daemonId: string, type: string, payload?: any) => Promise<any>
    sendData?: (daemonId: string, data: any) => boolean

    // Daemons
    /** All available daemons. Standalone: single-element. Cloud: multi. */
    daemons: RepoMeshDaemonEntry[]
    /** Logged-in user display name */
    userName?: string

    /**
     * Load live mesh status for the graph.
     * Cloud implementation uses loadCloudMeshStatusWithRetry(); standalone
     * calls mesh_status directly.
     */
    loadMeshStatus: (
        daemonId: string,
        meshId: string,
        opts?: LoadMeshStatusOptions,
    ) => Promise<any>

    /**
     * Launch a coordinator session.
     * Cloud passes inlineMesh + coordinatorNodeId resolved from live truth;
     * standalone sends launch_mesh_coordinator with only meshId + cliType.
     */
    launchCoordinator: (
        daemonId: string,
        params: LaunchCoordinatorParams,
    ) => Promise<LaunchCoordinatorResult>

    /**
     * Load live mesh from coordinator for command targeting (cloud only).
     * Standalone returns null.
     */
    loadLiveMesh?: (
        daemonId: string,
        meshId: string,
        inlineMesh: any,
    ) => Promise<any>

    /**
     * Extract a RepoMeshStatus from a loadMeshStatus response.
     * Cloud may need to unwrap a nested result layer.
     */
    extractStatus: (response: any) => RepoMeshStatus | null

    /**
     * Unwrap a raw daemon command response to its result body.
     * Cloud: `raw?.result ?? raw`. Standalone: identity.
     */
    unwrapResult: (raw: any) => any

    /**
     * Normalize a raw mesh record from the daemon into the page's MeshEntry shape.
     * Cloud passes normalizeMeshRecord(); standalone returns the value as-is.
     */
    normalizeMesh: (raw: any, sourceDaemonId: string) => any

    /**
     * Normalize a raw node record from the daemon into the page's MeshNode shape.
     * Cloud passes normalizeNodeRecord(); standalone returns the value as-is.
     */
    normalizeNode: (raw: any, meshId: string, sourceDaemonId: string) => any

    /**
     * Resolve the target daemon ID and command payload for a coordinator action
     * (queue load, coordinator launch). Cloud resolves against live mesh truth;
     * standalone returns the primary daemon ID.
     */
    resolveCommandTarget: (
        daemonId: string,
        meshId: string,
        mesh: any,
        nodes: any[],
        liveMesh?: any,
    ) => { targetDaemonId: string; inlineMesh?: any; coordinatorNodeId?: string } | { error: string }

    features: RepoMeshFeatures
}

// ─── Defaults (standalone) ───────────────────────────────────────

export const STANDALONE_FEATURES: RepoMeshFeatures = {
    // Multi-daemon UI — standalone has only one daemon, not applicable
    meshHostDaemonSection: false,
    createDaemonPicker: false,
    addNodeDaemonPicker: false,
    // Functional features — available on both platforms
    queueSection: true,
    coordinatorPrompt: true,
    nodeInstruction: true,
    hermesMcpConfig: true,
    // Standalone-specific: manual multi-machine host pairing
    hostPairing: true,
}

export const CLOUD_FEATURES: RepoMeshFeatures = {
    // Multi-daemon UI — cloud supports multiple connected daemons
    meshHostDaemonSection: true,
    createDaemonPicker: true,
    addNodeDaemonPicker: true,
    // Functional features — available on both platforms
    queueSection: true,
    coordinatorPrompt: true,
    nodeInstruction: true,
    hermesMcpConfig: true,
    // Not applicable in cloud (multi-daemon handled via meshHostDaemonSection)
    hostPairing: false,
}

// ─── Context ─────────────────────────────────────────────────────

const RepoMeshCtx = createContext<RepoMeshContextValue | null>(null)

export function useRepoMeshContext(): RepoMeshContextValue {
    const ctx = useContext(RepoMeshCtx)
    if (!ctx) throw new Error('useRepoMeshContext must be used inside RepoMeshProvider')
    return ctx
}

export { RepoMeshCtx as RepoMeshContext }
