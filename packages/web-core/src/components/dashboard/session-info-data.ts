/**
 * Pure data helpers for SessionInfoDialog — kept JSX-free so they can be unit
 * tested under the web-core node test environment. Resolves the mesh id / node id a
 * session is stamped with (coordinator or worker) and joins the matching live mesh
 * node out of a loadMeshStatus response.
 */
import { meshNodeIdMatches } from '@adhdev/mesh-shared'
import { extractRepoMeshStatus } from '../../utils/repo-mesh-status'
import type { ActiveConversation } from './types'

/** Subset of ActiveConversation the dialog reads for client-side enrichment. */
export type SessionInfoConversation = Pick<
    ActiveConversation,
    'settings' | 'git' | 'workspacePath' | 'transport' | 'machineName'
    | 'connectionState' | 'coordinator' | 'meshQueueStats' | 'agentType' | 'daemonId'
>

/** A live mesh node joined from loadMeshStatus by the session's stamped nodeId. */
export interface JoinedMeshNode {
    nodeId?: string
    workspace?: string
    repoRoot?: string
    daemonId?: string
    role?: string
    machineStatus?: string
    health?: string
    isLocalWorktree?: boolean
    worktreeBranch?: string
    launchReady?: boolean
    providers?: string[]
    providerPriority?: string[]
    git?: {
        branch?: string | null
        headCommit?: string | null
        ahead?: number
        behind?: number
        dirty?: boolean
        upstream?: string | null
    }
    connection?: {
        transport?: string
        state?: string
        rttMs?: number
    }
}

/**
 * Resolve the mesh id this session belongs to. A coordinator session carries it on
 * `coordinator.meshId`; a delegated worker carries it on the launch settings envelope
 * (`meshNodeFor` / `meshCoordinatorFor`). Returns null when the session is not a mesh
 * member.
 */
export function resolveSessionMeshId(conv: SessionInfoConversation | undefined): string | null {
    if (!conv) return null
    const fromCoordinator = conv.coordinator?.meshId
    if (typeof fromCoordinator === 'string' && fromCoordinator.trim()) return fromCoordinator.trim()
    const s = conv.settings || {}
    for (const key of ['meshNodeFor', 'meshCoordinatorFor']) {
        const v = s[key]
        if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
}

/** Resolve the mesh node id this session was dispatched to (settings stamp). */
export function resolveSessionMeshNodeId(conv: SessionInfoConversation | undefined): string | null {
    const s = conv?.settings || {}
    for (const key of ['meshNodeId', 'nodeId']) {
        const v = s[key]
        if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
}

/**
 * Join the live mesh node for a session out of a raw loadMeshStatus response. Returns
 * the trimmed JoinedMeshNode, or null when the response has no node matching the
 * stamped id (removed node, stale stamp, or a non-mesh response).
 */
export function joinMeshNodeForSession(meshStatusResponse: unknown, meshNodeId: string | null): JoinedMeshNode | null {
    if (!meshNodeId) return null
    const status = extractRepoMeshStatus(meshStatusResponse)
    const node = status?.nodes?.find(n => meshNodeIdMatches(n as any, meshNodeId))
    if (!node) return null
    return {
        nodeId: node.nodeId,
        workspace: node.workspace,
        repoRoot: (node as any).repoRoot,
        daemonId: node.daemonId,
        role: (node as any).role,
        machineStatus: node.machineStatus,
        health: node.health,
        isLocalWorktree: node.isLocalWorktree,
        worktreeBranch: node.worktreeBranch,
        launchReady: node.launchReady,
        providers: node.providers,
        providerPriority: node.providerPriority,
        git: node.git ? {
            branch: node.git.branch,
            headCommit: node.git.headCommit,
            ahead: node.git.ahead,
            behind: node.git.behind,
            dirty: (node.git as any).dirty,
            upstream: node.git.upstream,
        } : undefined,
        connection: node.connection ? {
            transport: node.connection.transport,
            state: node.connection.state,
            rttMs: node.connection.rttMs,
        } : undefined,
    }
}
