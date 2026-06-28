/**
 * MAGI (Multi-Agent Ground-truth Insight) dashboard surface — reachable subset.
 *
 * The dashboard reaches the coordinator daemon over P2P only through `mesh_status`
 * (see cloud `loadCloudMeshStatusWithRetry` / standalone provider). A
 * `mesh_magi_review` fan-out leaves three things in that payload:
 *   - a mission titled `MAGI: <question>` (status.missions[]),
 *   - one read-only task per replica, all sharing a `consensusGroupId`
 *     (status.queue.tasks[] — the field rides in the persisted entry even though
 *     the typed RepoMeshQueueTask projection omits it),
 *   - `task_dispatched` ledger entries with `payload.source === 'magi'` and any
 *     `magi_*` ledger kinds (status.ledger.entries[], a bounded tail).
 *
 * This module derives a `MagiActivitySummary` from exactly that already-reachable
 * data — no new daemon-core / mcp-server / mesh-tool wiring. It is a pure function
 * over the raw `mesh_status` response (or an already-extracted RepoMeshStatus).
 *
 * WIRING GAP — the MAGI *synthesis* result (claim clusters, the needs-verification
 * list, agreed clusters, the independence banner, open questions) is computed
 * ephemerally inside the `mesh_magi_review` MCP tool and returned only to the
 * coordinator agent. It is never persisted to the ledger / mesh store, so
 * `mesh_status` cannot carry it and the dashboard cannot read it. MAGI panel
 * definitions (`~/.adhdev/meshes.json` `magiPanels`) are machine-local config and
 * are likewise absent from `mesh_status`. Both are flagged unreachable here.
 */
import { readRecord, readString, type JsonRecord } from '@adhdev/mesh-shared'

/** Mission title prefix stamped by mesh_magi_review (`MAGI: <question>`). */
const MAGI_MISSION_TITLE_PREFIX = 'magi:'

/** Replica task statuses considered terminal (no further state transitions). */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** Stable, user-facing description of what synthesis data the dashboard cannot reach. */
export const MAGI_SYNTHESIS_WIRING_GAP =
    'MAGI synthesis (claim clusters, the needs-verification list, the independence banner, open questions) ' +
    'is computed inside the mesh_magi_review MCP tool and returned only to the coordinator agent — it is not ' +
    'persisted to the mesh ledger/store, so mesh_status (the dashboard P2P data layer) cannot read it. Panel ' +
    'definitions are machine-local config and are likewise absent from mesh_status. Reachable today: MAGI ' +
    'missions, per-replica task status grouped by consensus group, and MAGI dispatch/enqueue ledger events. To ' +
    'surface synthesis, mesh_magi_review must persist its MagiSynthesis (e.g. a ledger artifact or mission ' +
    'record) and mesh_status must fold it into its payload.'

export interface MagiReplicaActivity {
    taskId: string
    /** pending | assigned | completed | failed | cancelled (raw mesh task status). */
    status: string
    /** Resolved provider: assignedProviderType, else the `provider=` requiredTag. */
    provider?: string
    /** Resolved node: assignedNodeId, else targetNodeId. */
    nodeId?: string
    readonly: boolean
    terminal: boolean
}

export interface MagiReplicaCounts {
    pending: number
    assigned: number
    completed: number
    failed: number
    cancelled: number
}

export interface MagiGroupActivity {
    /** The shared consensusGroupId, or `mission:<id>` for a mission-only group. */
    consensusGroupId: string
    missionId?: string
    missionTitle?: string
    missionStatus?: string
    /** Question text, derived from the mission title (`MAGI:` prefix stripped) / goal. */
    question?: string
    replicas: MagiReplicaActivity[]
    replicaCount: number
    counts: MagiReplicaCounts
    /** Distinct providers among replicas — the independence signal reachable pre-synthesis. */
    distinctProviders: number
    /** Distinct nodes among replicas. */
    distinctNodes: number
    /**
     * True when the replicas collapse to a single provider or single machine — their
     * eventual agreements would be flagged source-coupled by MAGI synthesis. Only
     * meaningful for `source === 'queue'` groups (mission-only groups have no
     * per-replica identity, so this is always false there).
     */
    coupled: boolean
    /** completed / replicaCount, 0..1. */
    progress: number
    /** True when every replica has reached a terminal status (or the mission is closed). */
    terminal: boolean
    /**
     * 'queue' — replicas were read from live queue tasks (full per-replica detail).
     * 'mission' — the replicas have aged out of the bounded queue tail; only the
     * mission's task aggregate is reachable (no per-replica identity / independence).
     */
    source: 'queue' | 'mission'
}

export interface MagiLedgerEvent {
    id?: string
    timestamp?: string
    kind: string
    taskId?: string
    consensusGroupId?: string
    missionId?: string
    provider?: string
    nodeId?: string
    /** Best-effort human detail (e.g. the enqueue error). */
    detail?: string
}

export interface MagiActivitySummary {
    groups: MagiGroupActivity[]
    totalGroups: number
    /** Groups that are not yet fully terminal. */
    activeGroups: number
    /** MAGI dispatch / enqueue-failure entries from the bounded mesh_status ledger tail. */
    ledgerEvents: MagiLedgerEvent[]
    /** Always false — synthesis is not persisted (see MAGI_SYNTHESIS_WIRING_GAP). */
    synthesisReachable: false
    /** Always false — MAGI panels are machine-local config, not in mesh_status. */
    panelsReachable: false
    /** One-line description of the wiring gap for the dashboard to render. */
    wiringGap: string
}

/**
 * Unwrap the mesh_status body from a transport response. Mirrors
 * extractRepoMeshStatus's unwrap: cloud/P2P wraps the daemon payload under
 * `result` (optionally `result.status`); a raw RepoMeshStatus is passed through.
 */
function unwrapMeshStatusBody(response: unknown): JsonRecord {
    const root = readRecord(response)
    const result = root.result
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const inner = (result as JsonRecord).status
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as JsonRecord
        return result as JsonRecord
    }
    const status = root.status
    if (status && typeof status === 'object' && !Array.isArray(status)) return status as JsonRecord
    return root
}

function isMagiMissionTitle(title: string | undefined): boolean {
    return typeof title === 'string' && title.trim().toLowerCase().startsWith(MAGI_MISSION_TITLE_PREFIX)
}

/** Resolve a replica's provider: the assigned provider, else the `provider=` tag. */
function readProviderFromTask(task: JsonRecord): string | undefined {
    const assigned = readString(task.assignedProviderType)
    if (assigned) return assigned
    const tags = Array.isArray(task.requiredTags) ? task.requiredTags : []
    for (const tag of tags) {
        if (typeof tag !== 'string') continue
        const trimmed = tag.trim()
        if (trimmed.toLowerCase().startsWith('provider=')) {
            const provider = trimmed.slice('provider='.length).trim()
            if (provider) return provider
        }
    }
    return undefined
}

function readNodeFromTask(task: JsonRecord): string | undefined {
    return readString(task.assignedNodeId, task.targetNodeId)
}

function deriveQuestion(mission: JsonRecord | undefined): string | undefined {
    if (!mission) return undefined
    const title = readString(mission.title)
    if (title) {
        const stripped = title.replace(/^magi:\s*/i, '').trim()
        if (stripped) return stripped
    }
    return readString(mission.goal, mission.goalPreview)
}

function readCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function buildGroupFromTasks(
    consensusGroupId: string,
    tasks: JsonRecord[],
    mission: JsonRecord | undefined,
    missionId: string | undefined,
): MagiGroupActivity {
    const replicas: MagiReplicaActivity[] = tasks.map(task => {
        const status = readString(task.status) ?? 'pending'
        return {
            taskId: readString(task.id) ?? '',
            status,
            provider: readProviderFromTask(task),
            nodeId: readNodeFromTask(task),
            readonly: task.readonly === true || readString(task.taskMode) === 'live_debug_readonly',
            terminal: TERMINAL_TASK_STATUSES.has(status),
        }
    })
    const counts: MagiReplicaCounts = { pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const replica of replicas) {
        if (replica.status in counts) counts[replica.status as keyof MagiReplicaCounts] += 1
    }
    const distinctProviders = new Set(replicas.map(r => r.provider).filter((p): p is string => !!p)).size
    const distinctNodes = new Set(replicas.map(r => r.nodeId).filter((n): n is string => !!n)).size
    const replicaCount = replicas.length
    return {
        consensusGroupId,
        missionId,
        missionTitle: mission ? readString(mission.title) : undefined,
        missionStatus: mission ? readString(mission.status) : undefined,
        question: deriveQuestion(mission),
        replicas,
        replicaCount,
        counts,
        distinctProviders,
        distinctNodes,
        coupled: distinctProviders < 2 || distinctNodes < 2,
        progress: replicaCount > 0 ? counts.completed / replicaCount : 0,
        terminal: replicaCount > 0 && replicas.every(r => r.terminal),
        source: 'queue',
    }
}

function buildGroupFromMissionOnly(missionId: string, mission: JsonRecord): MagiGroupActivity {
    const aggregate = readRecord(mission.tasks)
    const counts: MagiReplicaCounts = {
        pending: readCount(aggregate.pending),
        assigned: readCount(aggregate.assigned),
        completed: readCount(aggregate.completed),
        failed: readCount(aggregate.failed),
        cancelled: readCount(aggregate.cancelled),
    }
    const total = readCount(aggregate.total)
        || counts.pending + counts.assigned + counts.completed + counts.failed + counts.cancelled
    const missionStatus = readString(mission.status)
    const terminal = missionStatus === 'completed'
        || missionStatus === 'abandoned'
        || (total > 0 && counts.pending === 0 && counts.assigned === 0)
    return {
        consensusGroupId: `mission:${missionId}`,
        missionId,
        missionTitle: readString(mission.title),
        missionStatus,
        question: deriveQuestion(mission),
        replicas: [],
        replicaCount: total,
        counts,
        distinctProviders: 0,
        distinctNodes: 0,
        coupled: false,
        progress: total > 0 ? counts.completed / total : 0,
        terminal,
        source: 'mission',
    }
}

function extractMagiLedgerEvents(entries: unknown[]): MagiLedgerEvent[] {
    const events: MagiLedgerEvent[] = []
    for (const entry of entries) {
        const record = readRecord(entry)
        const kind = readString(record.kind) ?? ''
        const payload = readRecord(record.payload)
        const consensusGroupId = readString(payload.consensusGroupId, record.consensusGroupId)
        const isMagiDispatch = kind === 'task_dispatched' && readString(payload.source) === 'magi'
        const isMagiKind = kind.startsWith('magi_')
        if (!isMagiDispatch && !isMagiKind && !consensusGroupId) continue
        events.push({
            id: readString(record.id),
            timestamp: readString(record.timestamp),
            kind,
            taskId: readString(payload.taskId, record.taskId),
            consensusGroupId,
            missionId: readString(payload.missionId),
            provider: readString(record.providerType, payload.providerType, payload.provider),
            nodeId: readString(record.nodeId, payload.nodeId),
            detail: readString(payload.error),
        })
    }
    return events
}

/**
 * Derive the reachable MAGI activity surface from a raw `mesh_status` response (or
 * an already-extracted RepoMeshStatus). Pure — no transport, no daemon calls. The
 * returned summary always flags `synthesisReachable: false` / `panelsReachable:
 * false` with `wiringGap` describing what would need to be wired to surface more.
 */
export function extractMagiActivity(response: unknown): MagiActivitySummary {
    const status = unwrapMeshStatusBody(response)
    const queue = readRecord(status.queue)
    const tasks = Array.isArray(queue.tasks) ? queue.tasks.map(readRecord) : []
    const missions = Array.isArray(status.missions) ? status.missions.map(readRecord) : []
    const ledger = readRecord(status.ledger)
    const ledgerEntries = Array.isArray(ledger.entries) ? ledger.entries : []

    const missionById = new Map<string, JsonRecord>()
    for (const mission of missions) {
        const id = readString(mission.id)
        if (id) missionById.set(id, mission)
    }

    // 1. Group live queue tasks by their shared consensusGroupId (MAGI replicas).
    const tasksByConsensus = new Map<string, JsonRecord[]>()
    for (const task of tasks) {
        const consensusGroupId = readString(task.consensusGroupId)
        if (!consensusGroupId) continue
        const bucket = tasksByConsensus.get(consensusGroupId) ?? []
        bucket.push(task)
        tasksByConsensus.set(consensusGroupId, bucket)
    }

    const groups: MagiGroupActivity[] = []
    const consumedMissionIds = new Set<string>()
    for (const [consensusGroupId, groupTasks] of tasksByConsensus) {
        const missionId = groupTasks.map(t => readString(t.missionId)).find((id): id is string => !!id)
        const mission = missionId ? missionById.get(missionId) : undefined
        if (missionId) consumedMissionIds.add(missionId)
        groups.push(buildGroupFromTasks(consensusGroupId, groupTasks, mission, missionId))
    }

    // 2. Fold in MAGI missions whose replicas have aged out of the queue tail.
    for (const [missionId, mission] of missionById) {
        if (consumedMissionIds.has(missionId)) continue
        if (!isMagiMissionTitle(readString(mission.title))) continue
        groups.push(buildGroupFromMissionOnly(missionId, mission))
    }

    // Active (non-terminal) groups first; otherwise preserve discovery order.
    groups.sort((a, b) => Number(a.terminal) - Number(b.terminal))

    return {
        groups,
        totalGroups: groups.length,
        activeGroups: groups.filter(g => !g.terminal).length,
        ledgerEvents: extractMagiLedgerEvents(ledgerEntries),
        synthesisReachable: false,
        panelsReachable: false,
        wiringGap: MAGI_SYNTHESIS_WIRING_GAP,
    }
}
