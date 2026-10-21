/**
 * assistant-protocol — the assistant layer's tool and daemon-verb names
 * (docs/design/2026-10-07-assistant-layer.md §4.4).
 *
 * The single source for both halves of the assistant contract, like
 * `WORKER_TOOLS` is for workers:
 *   - `ASSISTANT_TOOLS` — exactly what `adhdev mcp --assistant` will advertise
 *     (an mcp-server parity test pins ListTools to this tuple once that mode
 *     lands);
 *   - `ASSISTANT_TOOL_VERBS` — the daemon command each tool calls;
 *   - the daemon-only verbs (launch / MCP-only pull / owner actions) that have
 *     no tool.
 *
 * Assistant-specific tools remain separate from mesh tools. Driver discovery
 * (list/describe) is shared across all three modes; invoke remains Worker-only.
 */

export const ASSISTANT_TOOLS = [
    'projects',
    'environment',
    'assistant_action',
    'project_watch',
    'project_status',
    'project_send',
    'project_read',
    'project_add',
    'project_attach_remote',
    'discover_repos',
    'memory',
    'skill_view',
    'skill_manage',
    'project_note',
    'launch_defaults',
    'launch_defaults_set',
    'driver_list',
    'driver_describe',
] as const

export type AssistantTool = typeof ASSISTANT_TOOLS[number]

const ASSISTANT_TOOL_SET: ReadonlySet<string> = new Set(ASSISTANT_TOOLS)

export function isAssistantTool(value: unknown): value is AssistantTool {
    return typeof value === 'string' && ASSISTANT_TOOL_SET.has(value)
}

/** Daemon verb names (§4.4 table + the five verbs below it). */
export const ASSISTANT_VERB = {
    // tool verbs
    driverList: 'driver_list',
    driverDescribe: 'driver_describe',
    projects: 'assistant_projects',
    environment: 'assistant_environment',
    action: 'assistant_action',
    watch: 'assistant_project_watch',
    executionState: 'assistant_execution_state',
    executionSettings: 'assistant_execution_settings',
    projectStatus: 'assistant_project_status',
    projectSend: 'assistant_project_send',
    projectRead: 'assistant_project_read',
    projectAdd: 'assistant_project_add',
    projectAttachRemote: 'assistant_project_attach_remote',
    discoverRepos: 'assistant_discover_repos',
    memory: 'assistant_memory',
    skillView: 'assistant_skill_view',
    skillManage: 'assistant_skill_manage',
    projectNote: 'assistant_project_note',
    launchDefaults: 'assistant_launch_defaults',
    launchDefaultsSet: 'assistant_launch_defaults_set',
    // assistant-side daemon verbs without a tool of the same name
    launch: 'launch_assistant',
    pendingRelays: 'assistant_pending_relays',
    // owner verbs (dashboard only)
    stagedResolve: 'assistant_staged_resolve',
    storeAdmin: 'assistant_store_admin',
    importSkills: 'assistant_import_skills',
    /** Projects the assistant is following (open relay threads) — list / stop following. */
    threads: 'assistant_threads',
    threadClose: 'assistant_thread_close',
} as const

export type AssistantVerb = typeof ASSISTANT_VERB[keyof typeof ASSISTANT_VERB]

/** The daemon verb each assistant tool calls. */
export const ASSISTANT_TOOL_VERBS: Readonly<Record<AssistantTool, AssistantVerb>> = {
    driver_list: ASSISTANT_VERB.driverList,
    driver_describe: ASSISTANT_VERB.driverDescribe,
    projects: ASSISTANT_VERB.projects,
    environment: ASSISTANT_VERB.environment,
    assistant_action: ASSISTANT_VERB.action,
    project_watch: ASSISTANT_VERB.watch,
    project_status: ASSISTANT_VERB.projectStatus,
    project_send: ASSISTANT_VERB.projectSend,
    project_read: ASSISTANT_VERB.projectRead,
    project_add: ASSISTANT_VERB.projectAdd,
    project_attach_remote: ASSISTANT_VERB.projectAttachRemote,
    discover_repos: ASSISTANT_VERB.discoverRepos,
    memory: ASSISTANT_VERB.memory,
    skill_view: ASSISTANT_VERB.skillView,
    skill_manage: ASSISTANT_VERB.skillManage,
    project_note: ASSISTANT_VERB.projectNote,
    launch_defaults: ASSISTANT_VERB.launchDefaults,
    launch_defaults_set: ASSISTANT_VERB.launchDefaultsSet,
}

/**
 * Tools annotated as writes; every other assistant tool is read-only. §4.4
 * lists the three store writes; project_send and project_add are here too
 * because they cause effects (a coordinator message or launch, a new
 * project), and MCP clients use readOnlyHint to skip confirmation.
 */
export const ASSISTANT_WRITE_TOOLS: readonly AssistantTool[] = ['project_watch', 'assistant_action', 'memory', 'skill_manage', 'project_note', 'project_send', 'project_add', 'project_attach_remote', 'launch_defaults_set']

/** Owner-only verbs: never reachable from the assistant's MCP server (no `ipc`). */
export const ASSISTANT_OWNER_VERBS: readonly AssistantVerb[] = [
    ASSISTANT_VERB.executionSettings,
    ASSISTANT_VERB.stagedResolve,
    ASSISTANT_VERB.storeAdmin,
    ASSISTANT_VERB.importSkills,
    ASSISTANT_VERB.threadClose,
]

/** The only assistant verbs accepted while an idle review turn is open (§4.10.7). */
export const ASSISTANT_REVIEW_TURN_VERBS: readonly AssistantVerb[] = [
    ASSISTANT_VERB.memory,
    ASSISTANT_VERB.skillView,
    ASSISTANT_VERB.skillManage,
    ASSISTANT_VERB.projectNote,
]

import { canonicalDaemonId } from './daemon-normalize'

/** Env var the daemon sets on the assistant CLI's process (§4.5), read by the
 * assistant MCP server and forwarded on every verb as
 * `ASSISTANT_SESSION_ID_ARG`. Routing / ownership only — never an auth gate.
 */
export const ASSISTANT_SESSION_ID_ENV = 'ADHDEV_ASSISTANT_SESSION_ID'

/** Request arg carrying the calling assistant session id. */
export const ASSISTANT_SESSION_ID_ARG = 'assistantSessionId'

// ─── Remote Assistant Project Follow & Host-Authoritative Grant (rc24) ──────

/**
 * Conceptual single-assistant slot in the verified account namespace.
 * Fixed to `'personal'` — one logical assistant per account with one
 * owner-selected active execution daemon binding per project ACL.
 */
export const ASSISTANT_ACCOUNT_SLOT = 'personal' as const
export type AssistantAccountSlot = typeof ASSISTANT_ACCOUNT_SLOT

/**
 * Daemon commands for remote project discovery, host ACL grant/revoke, and
 * assistant-side follow/unfollow. Registered outside `ASSISTANT_VERB` so the
 * assistant MCP server tool/verb parity table remains untouched.
 */
export const ASSISTANT_REMOTE_PROJECT_COMMAND = 'assistant_remote_project' as const
export const ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND = 'assistant_remote_project_catalog' as const
export const ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND = 'assistant_remote_project_access' as const
export const ASSISTANT_REMOTE_FOLLOW_COMMAND = 'assistant_remote_follow' as const

/**
 * Narrow operations a non-roster follower deputy is permitted to invoke on
 * `assistant_remote_project` when the host's `assistantRemoteAccess` ACL is active.
 * `note`, `terminal`, and `inventory` remain strictly roster-member-only.
 */
export const ASSISTANT_FOLLOWER_ALLOWED_OPS = ['status', 'read', 'poll', 'report', 'send'] as const
export type AssistantFollowerAllowedOp = typeof ASSISTANT_FOLLOWER_ALLOWED_OPS[number]

const ASSISTANT_FOLLOWER_ALLOWED_OP_SET: ReadonlySet<string> = new Set(ASSISTANT_FOLLOWER_ALLOWED_OPS)

export function isAssistantFollowerAllowedOp(value: unknown): value is AssistantFollowerAllowedOp {
    return typeof value === 'string' && ASSISTANT_FOLLOWER_ALLOWED_OP_SET.has(value)
}

/**
 * Host-authoritative narrow project ACL persisted on the hosting daemon's
 * `LocalMeshEntry` in `meshes.json`. Revocation increments `grantRevision`
 * and retains a `'revoked'` tombstone so stale follower caches cannot replay.
 */
export interface AssistantRemoteAccessBinding {
    hostDaemonId: string
    meshId: string
    accountSlot: AssistantAccountSlot
    activeDaemonId: string
    bindingRevision: number
    grantRevision: number
    status: 'active' | 'revoked'
    allowedOps: readonly AssistantFollowerAllowedOp[]
    grantedAt: number
    revokedAt?: number
}

/**
 * Durable owner-binding receipt persisted in the assistant daemon's
 * `assistant.json`. Survives ordinary daemon restarts and session/provider
 * replacements (`bindSession`), while missing/corrupt/mismatched receipts
 * fail closed until owner reconciliation.
 */
export interface AssistantOwnerBindingReceipt {
    accountSlot: AssistantAccountSlot
    daemonId: string
    bindingRevision: number
    boundAt: number | string
}

export type FollowedRemoteProjectState = 'followed' | 'unfollowed' | 'revoked'

export type RemoteAccessState =
    | 'not_granted'
    | 'granted_unfollowed'
    | 'followed'
    | 'revoked'
    | 'host_unreachable'
    | 'binding_mismatch'

/**
 * Assistant-local followed remote project reference persisted in `assistant.json`.
 * Never injected into `meshes.json`, `mesh-host-records.json`, `mesh-node-state-push.json`,
 * or `inlineMeshCache`.
 */
export interface FollowedRemoteProjectEntry {
    /** Canonical key: `${canonicalDaemonId(hostDaemonId)}::${meshId}` */
    key: string
    hostDaemonId: string
    hostLabel?: string
    meshId: string
    name: string
    slug: string
    sanitizedRepoIdentity: string | null
    repoIdentity?: string
    accountSlot: AssistantAccountSlot
    bindingRevision: number
    grantRevision: number
    state: FollowedRemoteProjectState
    followedAt: number | string
    updatedAt: number | string
    unfollowedAt?: number | string
    revokedAt?: number | string
    revokedReason?: string
    lastCursor?: string | null
    coordinatorSessionId?: string | null
    lastErrorCode?: string
    lastObserved?: {
        observedAt: number | string
        coordinatorState?: string
        coordinatorMissing?: boolean
        coordinatorPresent?: boolean
        lastHeadline?: string
        summary?: string
    }
}

/**
 * Content-free canonical catalog metadata returned by `assistant_remote_project_catalog`
 * for meshes actually hosted on the queried remote daemon.
 */
export interface RemoteProjectCatalogItem {
    hostDaemonId: string
    meshId: string
    name: string
    sanitizedRepoIdentity: string | null
    coordinatorState?: 'none' | 'idle' | 'working' | 'waiting' | string
    capabilities: {
        status: true
        read: true
        poll: true
        report: true
        send: true
        coordinatorPresent?: boolean
    }
    observedAt: number | string
}

/** Build the canonical `(hostDaemonId, meshId)` key used across assistant follow state. */
export function followedRemoteProjectKey(hostDaemonId: string, meshId: string): string {
    const canonHost = canonicalDaemonId(hostDaemonId) ?? hostDaemonId.trim()
    return `${canonHost}::${meshId.trim()}`
}

/**
 * Sanitize a repository identity or remote URL into a content-free `host/path`
 * identifier suitable for remote discovery catalogs. Strips credentials, query
 * strings, fragments, and `.git` suffixes, and rejects local filesystem paths.
 */
export function sanitizeRemoteRepoIdentity(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    // Reject local filesystem paths (Unix absolute/relative/home, Windows drive/UNC, file:// URLs).
    if (
        trimmed.startsWith('/')
        || trimmed.startsWith('./')
        || trimmed.startsWith('../')
        || trimmed.startsWith('~/')
        || trimmed.startsWith('\\')
        || /^[a-zA-Z]:[\\/]/.test(trimmed)
        || /^file:/i.test(trimmed)
    ) {
        return null
    }

    const withoutQuery = trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (!withoutQuery) return null

    let host = ''
    let repoPath = ''

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery)) {
        try {
            const url = new URL(withoutQuery)
            if (url.protocol === 'file:') return null
            host = url.hostname.toLowerCase()
            repoPath = decodeURIComponent(url.pathname)
                .replace(/^\/+|\/+$/g, '')
                .replace(/\.git$/i, '')
        } catch {
            return null
        }
    } else {
        const scpMatch = withoutQuery.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/)
        if (scpMatch) {
            host = scpMatch[1].replace(/^\[|\]$/g, '').toLowerCase()
            repoPath = scpMatch[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
        } else {
            const slash = withoutQuery.indexOf('/')
            if (slash > 0) {
                const rawHost = withoutQuery.slice(0, slash)
                const atIdx = rawHost.lastIndexOf('@')
                host = (atIdx >= 0 ? rawHost.slice(atIdx + 1) : rawHost).toLowerCase()
                repoPath = withoutQuery.slice(slash + 1).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
            }
        }
    }

    if (!host || !repoPath) return null
    if (!host.includes('.') && host !== 'localhost') return null
    if (/[\s@:\\]/.test(host)) return null
    const segments = repoPath.split('/').filter(Boolean)
    if (segments.length === 0) return null
    if (segments.some(seg => seg === '.' || seg === '..' || /[\s@:\\]/.test(seg))) return null

    return `${host}/${segments.join('/')}`.slice(0, 200)
}

