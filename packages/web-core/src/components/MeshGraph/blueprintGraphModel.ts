/**
 * blueprintGraphModel — the pure view model behind the Blueprint GRAPH view
 * (MeshBlueprintGraph): queue tasks as nodes, their `depends_on` as edges
 * (mesh_status queue.tasks carry dependsOn / missionId).
 *
 * Three pure stages, so every rule is unit-testable without React Flow or ELK:
 *   buildBlueprintGraphModel  — everything, no viewer preferences
 *   applyBlueprintGraphView   — active-only filter, lane collapse, completed fold
 *   blueprintGraphStructureKey — the re-layout key (ids + shape, never status)
 */
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { buildTaskDag } from './taskDagViewModel'
import { buildQueueChainIndex, deriveSessionActivity } from './useBlueprintGroups'
import { queueTaskDisplayText } from '../../utils/queue-task-label'

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

/**
 * Task tone — the node colour. `dead` = pending but can never start on its own
 * because a dependency (directly or transitively) failed/was cancelled.
 */
export type BlueprintGraphTaskTone = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dead'

/** satisfied: source done · waiting: source in flight · dead: target can never start. */
export type BlueprintGraphEdgeState = 'satisfied' | 'waiting' | 'dead'

export interface BlueprintGraphTaskNode {
    kind: 'task'
    id: string
    groupKey: string
    /** Backing queue row id. */
    taskId: string
    /** First line of the task text, trimmed to BLUEPRINT_GRAPH_TITLE_MAX. */
    title: string
    /** Whole display text — the hover tooltip. */
    fullTitle: string
    tone: BlueprintGraphTaskTone
    /** Raw queue status, for the tooltip. */
    rawStatus: string
    /** Claiming session is live-generating (assigned only). */
    generating: boolean
    provider?: string
    assignedNodeId?: string
    missionId?: string
    createdAt?: string
    updatedAt?: string
    dispatchedAt?: string
    /** G7 delayed-execution hold (queue `notBefore`). */
    notBefore?: string
    /** Set on `dead` nodes: 'direct' = a dependency itself failed/cancelled. */
    deadReason?: 'direct' | 'transitive'
    /** Dependency ids referenced but absent from the snapshot. */
    missingDeps: string[]
}

/** Folded completed tasks of one lane ("✓ N done"). Only exists in views. */
export interface BlueprintGraphFoldNode {
    kind: 'fold'
    id: string
    groupKey: string
    count: number
    /** The folded task ids (tooltip). */
    memberIds: string[]
}

export type BlueprintGraphNode = BlueprintGraphTaskNode | BlueprintGraphFoldNode

export interface BlueprintGraphEdge {
    id: string
    source: string
    target: string
    state: BlueprintGraphEdgeState
    /** Target is running — the one edge that moves. */
    animated: boolean
}

export type BlueprintGraphGroupKind = 'mission' | 'chain' | 'adhoc'

export interface BlueprintGraphGroupCounts {
    total: number
    running: number
    pending: number
    dead: number
    completed: number
    failed: number
    cancelled: number
}

export interface BlueprintGraphGroup {
    key: string
    kind: BlueprintGraphGroupKind
    /** Mission title, chain anchor title, or null (caller labels it). */
    title: string | null
    missionId?: string
    anchorTaskId?: string
    nodeIds: string[]
    counts: BlueprintGraphGroupCounts
    /** At least one node is not terminal (dead-blocked counts: it needs a human). */
    live: boolean
    lastActivityAt: string
    /** Newest member CREATION time — the lane sort key. Unlike lastActivityAt
     *  it does not move on a status poll, so lanes never reshuffle live. */
    newestCreatedAt: string
}

export interface BlueprintGraphModel {
    nodes: BlueprintGraphNode[]
    edges: BlueprintGraphEdge[]
    groups: BlueprintGraphGroup[]
    /** True when the snapshot holds at least one dependency edge. */
    hasStructure: boolean
}

export const BLUEPRINT_GRAPH_TITLE_MAX = 64
const ADHOC_GROUP_KEY = 'adhoc'

/* ── Helpers ────────────────────────────────────────────────────────────── */

export function firstLineTitle(text: string, max: number = BLUEPRINT_GRAPH_TITLE_MAX): string {
    const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? ''
    return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line
}

export function queueStatusTone(status: string): BlueprintGraphTaskTone {
    switch (status) {
        case 'assigned': return 'running'
        case 'completed': return 'completed'
        case 'failed': return 'failed'
        case 'cancelled': return 'cancelled'
        default: return 'pending'
    }
}

/** A node that will not advance again on its own. */
export function isTerminalGraphNode(node: BlueprintGraphNode): boolean {
    if (node.kind === 'fold') return true
    return node.tone === 'completed' || node.tone === 'failed' || node.tone === 'cancelled'
}

/** Source is finished successfully — the edge out of it is satisfied. */
function isSatisfiedSource(node: BlueprintGraphNode): boolean {
    if (node.kind === 'fold') return true
    return node.tone === 'completed'
}

/** Source ended in a way that can never satisfy a dependent. */
function isDeadSource(node: BlueprintGraphNode): boolean {
    if (node.kind === 'fold') return false
    return node.tone === 'failed' || node.tone === 'cancelled' || node.tone === 'dead'
}

function taskNodeId(taskId: string): string {
    return `task:${taskId}`
}

/* ── Stage 1: the full model ────────────────────────────────────────────── */

export function buildBlueprintGraphModel(
    tasks: ReadonlyArray<RepoMeshQueueTask> | null | undefined,
    status?: Pick<RepoMeshStatus, 'nodes'> | null,
    missionTitles?: Readonly<Record<string, string>>,
): BlueprintGraphModel {
    const dag = buildTaskDag(tasks ? [...tasks] : [])
    const chainByTaskId = buildQueueChainIndex(dag)
    const nodeById = new Map<string, BlueprintGraphTaskNode>()

    for (const dagNode of dag.nodes) {
        const task = dagNode.task
        const text = queueTaskDisplayText(task.message)
        const activity = task.status === 'assigned' ? deriveSessionActivity(status ?? null, task) : undefined
        const node: BlueprintGraphTaskNode = {
            kind: 'task',
            id: taskNodeId(task.id),
            groupKey: '',
            taskId: task.id,
            title: firstLineTitle(text) || task.id.slice(0, 8),
            fullTitle: text,
            tone: queueStatusTone(task.status),
            rawStatus: task.status,
            generating: Boolean(activity?.generating),
            ...(task.assignedProviderType || task.autoLaunch?.providerType ? { provider: task.assignedProviderType || task.autoLaunch?.providerType } : {}),
            ...(task.assignedNodeId ? { assignedNodeId: task.assignedNodeId } : {}),
            ...(typeof task.missionId === 'string' && task.missionId ? { missionId: task.missionId } : {}),
            ...(task.createdAt ? { createdAt: task.createdAt } : {}),
            ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
            ...(task.dispatchTimestamp ? { dispatchedAt: task.dispatchTimestamp } : {}),
            ...(typeof task.notBefore === 'string' && task.notBefore ? { notBefore: task.notBefore } : {}),
            missingDeps: dagNode.missingDeps,
        }
        nodeById.set(node.id, node)
    }

    // Edges: queue dependsOn, one edge per (source, target).
    const edgeByPair = new Map<string, { source: string; target: string }>()
    for (const edge of dag.edges) {
        const source = taskNodeId(edge.source)
        const target = taskNodeId(edge.target)
        edgeByPair.set(`${source}->${target}`, { source, target })
    }
    // Dead-dependency propagation to a fixpoint: a not-yet-started task with
    // any dependency that failed/cancelled (or is itself dead) can never start
    // on its own under the default `block` policy.
    const incoming = new Map<string, string[]>()
    for (const edge of edgeByPair.values()) {
        incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
    }
    const taskById = new Map(dag.nodes.map(dagNode => [dagNode.id, dagNode.task]))
    for (const node of nodeById.values()) {
        if (node.tone !== 'pending') continue
        const task = taskById.get(node.taskId)
        if ((task?.dependencyFailures?.length ?? 0) > 0) {
            node.tone = 'dead'
            node.deadReason = 'direct'
        }
    }
    let changed = true
    let guard = nodeById.size + 1
    while (changed && guard-- > 0) {
        changed = false
        for (const node of nodeById.values()) {
            if (node.tone !== 'pending') continue
            const sources = (incoming.get(node.id) ?? []).map(id => nodeById.get(id)).filter((n): n is BlueprintGraphTaskNode => Boolean(n))
            const deadSources = sources.filter(isDeadSource)
            if (deadSources.length === 0) continue
            node.tone = 'dead'
            node.deadReason = deadSources.some(source => source.tone !== 'dead') ? 'direct' : 'transitive'
            changed = true
        }
    }

    const edges: BlueprintGraphEdge[] = []
    for (const [pair, edge] of edgeByPair) {
        const source = nodeById.get(edge.source)
        const target = nodeById.get(edge.target)
        if (!source || !target) continue
        const state: BlueprintGraphEdgeState = target.tone === 'dead'
            ? 'dead'
            : isSatisfiedSource(source) ? 'satisfied' : 'waiting'
        edges.push({
            id: `e:${pair}`,
            source: edge.source,
            target: edge.target,
            state,
            animated: target.tone === 'running',
        })
    }
    edges.sort((a, b) => a.id.localeCompare(b.id))

    // Grouping: own mission → chain mission → chain → ad-hoc.
    const groupHeads = new Map<string, Omit<BlueprintGraphGroup, 'nodeIds' | 'counts' | 'live' | 'lastActivityAt' | 'newestCreatedAt'>>()
    for (const node of nodeById.values()) {
        const chain = chainByTaskId.get(node.taskId)
        const missionId = node.missionId || chain?.inheritedMissionId
        let head: Omit<BlueprintGraphGroup, 'nodeIds' | 'counts' | 'live' | 'lastActivityAt' | 'newestCreatedAt'>
        if (missionId) {
            head = { key: `mission:${missionId}`, kind: 'mission', title: missionTitles?.[missionId] ?? null, missionId }
        } else if (chain) {
            head = { key: chain.key, kind: 'chain', title: chain.anchorTitle, anchorTaskId: chain.anchorTaskId }
        } else {
            head = { key: ADHOC_GROUP_KEY, kind: 'adhoc', title: null }
        }
        node.groupKey = head.key
        if (!groupHeads.has(head.key)) groupHeads.set(head.key, head)
    }

    // Stable node order: by group, then creation time, then id — ELK's model
    // order follows it, so a status poll never reshuffles the drawing.
    const nodes = [...nodeById.values()].sort((a, b) =>
        a.groupKey.localeCompare(b.groupKey)
        || nodeTime(a).localeCompare(nodeTime(b))
        || a.id.localeCompare(b.id))

    const groups: BlueprintGraphGroup[] = []
    for (const head of groupHeads.values()) {
        const members = nodes.filter(node => node.groupKey === head.key)
        const counts: BlueprintGraphGroupCounts = { total: members.length, running: 0, pending: 0, dead: 0, completed: 0, failed: 0, cancelled: 0 }
        let lastActivityAt = ''
        let newestCreatedAt = ''
        for (const node of members) {
            const created = nodeTime(node)
            if (created > newestCreatedAt) newestCreatedAt = created
            if (node.tone === 'running') counts.running += 1
            else if (node.tone === 'pending') counts.pending += 1
            else if (node.tone === 'dead') counts.dead += 1
            else if (node.tone === 'completed') counts.completed += 1
            else if (node.tone === 'failed') counts.failed += 1
            else if (node.tone === 'cancelled') counts.cancelled += 1
            const at = node.updatedAt || node.createdAt || ''
            if (at > lastActivityAt) lastActivityAt = at
        }
        groups.push({
            ...head,
            nodeIds: members.map(node => node.id),
            counts,
            live: members.some(node => !isTerminalGraphNode(node)),
            lastActivityAt,
            newestCreatedAt,
        })
    }
    // Live lanes first, then newest-created; ad-hoc last among equals. Status
    // polls never reorder lanes (only liveness flips or new members can).
    groups.sort((a, b) =>
        Number(b.live) - Number(a.live)
        || Number(a.kind === 'adhoc') - Number(b.kind === 'adhoc')
        || b.newestCreatedAt.localeCompare(a.newestCreatedAt)
        || a.key.localeCompare(b.key))

    return { nodes, edges, groups, hasStructure: edges.length > 0 }
}

function nodeTime(node: BlueprintGraphNode): string {
    return node.kind === 'task' ? node.createdAt || '' : ''
}

/**
 * Default for the List / Graph switch when the viewer has no stored choice:
 * Graph as soon as there is structure to draw (a dependency edge), List for a
 * flat pile of independent tasks — boxes with no lines explain nothing a row
 * doesn't.
 */
export function snapshotHasStructure(
    tasks: ReadonlyArray<Pick<RepoMeshQueueTask, 'dependsOn'>> | null | undefined,
): boolean {
    return (tasks ?? []).some(task => Array.isArray(task.dependsOn) && task.dependsOn.length > 0)
}

/* ── Stage 2: viewer preferences → the visible graph ────────────────────── */

/** Fold completed tasks of a live lane once there are at least this many. */
export const BLUEPRINT_GRAPH_FOLD_MIN = 3

export interface BlueprintGraphViewPrefs {
    /** Hide lanes with no live work at all. */
    activeOnly: boolean
    /** groupKey → explicit lane collapse (default: collapsed when not live). */
    collapsed?: Readonly<Record<string, boolean>>
    /** groupKey → explicit completed-fold (default: live lane with ≥ FOLD_MIN completed). */
    folded?: Readonly<Record<string, boolean>>
}

export interface BlueprintGraphLane {
    group: BlueprintGraphGroup
    collapsed: boolean
    folded: boolean
    /** Whether a fold toggle makes sense (≥ 1 completed task). */
    canFold: boolean
    /** Visible node ids in this lane (empty when collapsed). */
    nodeIds: string[]
}

export interface BlueprintGraphViewResult {
    lanes: BlueprintGraphLane[]
    nodes: BlueprintGraphNode[]
    edges: BlueprintGraphEdge[]
    /** Lanes hidden by the active-only filter. */
    hiddenLaneCount: number
}

export function defaultLaneCollapsed(group: BlueprintGraphGroup): boolean {
    return !group.live
}

export function defaultLaneFolded(group: BlueprintGraphGroup): boolean {
    return group.live && group.counts.completed >= BLUEPRINT_GRAPH_FOLD_MIN
}

export function applyBlueprintGraphView(model: BlueprintGraphModel, prefs: BlueprintGraphViewPrefs): BlueprintGraphViewResult {
    const nodeById = new Map(model.nodes.map(node => [node.id, node]))
    const lanes: BlueprintGraphLane[] = []
    const visible = new Map<string, BlueprintGraphNode>()
    /** Folded task id → the fold node that stands in for it. */
    const foldOf = new Map<string, string>()
    let hiddenLaneCount = 0
    for (const group of model.groups) {
        if (prefs.activeOnly && !group.live) { hiddenLaneCount += 1; continue }
        const collapsed = prefs.collapsed?.[group.key] ?? defaultLaneCollapsed(group)
        const canFold = group.counts.completed > 0
        const folded = canFold && (prefs.folded?.[group.key] ?? defaultLaneFolded(group))
        const nodeIds: string[] = []
        if (!collapsed) {
            const foldMembers: string[] = []
            for (const id of group.nodeIds) {
                const node = nodeById.get(id)!
                if (folded && node.kind === 'task' && node.tone === 'completed') {
                    foldMembers.push(id)
                    continue
                }
                visible.set(id, node)
                nodeIds.push(id)
            }
            if (foldMembers.length > 0) {
                const fold: BlueprintGraphFoldNode = { kind: 'fold', id: `fold:${group.key}`, groupKey: group.key, count: foldMembers.length, memberIds: foldMembers }
                for (const id of foldMembers) foldOf.set(id, fold.id)
                visible.set(fold.id, fold)
                nodeIds.unshift(fold.id)
            }
        }
        lanes.push({ group, collapsed, folded, canFold, nodeIds })
    }
    const edges: BlueprintGraphEdge[] = []
    const seen = new Set<string>()
    for (const edge of model.edges) {
        const source = foldOf.get(edge.source) ?? edge.source
        const target = foldOf.get(edge.target) ?? edge.target
        if (source === target || !visible.has(source) || !visible.has(target)) continue
        const rewired = source !== edge.source || target !== edge.target
        const id = rewired ? `e:${source}->${target}` : edge.id
        if (seen.has(id)) continue
        seen.add(id)
        edges.push(rewired ? { ...edge, id, source, target } : edge)
    }
    const nodes: BlueprintGraphNode[] = []
    for (const lane of lanes) for (const id of lane.nodeIds) nodes.push(visible.get(id)!)
    return { lanes, nodes, edges, hiddenLaneCount }
}

/* ── Stage 3: the re-layout key ─────────────────────────────────────────── */

/**
 * Everything the LAYOUT depends on and nothing else: lane order + collapse,
 * visible node ids + kinds (sizes differ per kind), edge endpoints. Status,
 * titles, times and edge colours are deliberately absent — a status poll
 * that changes none of these must not re-run ELK or move a single node.
 */
export function blueprintGraphStructureKey(view: Pick<BlueprintGraphViewResult, 'lanes' | 'nodes' | 'edges'>): string {
    const kindById = new Map(view.nodes.map(node => [node.id, node.kind]))
    const lanes = view.lanes.map(lane => `${lane.group.key}${lane.collapsed ? '#c' : ''}[${lane.nodeIds.map(id => `${kindById.get(id)?.[0] ?? '?'}:${id}`).join(',')}]`)
    const edges = view.edges.map(edge => `${edge.source}>${edge.target}`).sort()
    return `${lanes.join('|')}::${edges.join(',')}`
}

/** The lane SET alone (order-free) — the fit-to-view key: lanes appearing or leaving. */
export function blueprintGraphLaneKey(view: Pick<BlueprintGraphViewResult, 'lanes'>): string {
    return view.lanes.map(lane => lane.group.key).sort().join('|')
}

/* ── Time readings (pure; the card formats them) ────────────────────────── */

export interface TaskNodeTimeReading {
    /** running: elapsed since dispatch · finished: when it ended · queued: waiting since creation. */
    kind: 'running' | 'finished' | 'queued'
    at: string
    elapsedMs: number
}

export function taskNodeTimeReading(
    node: Pick<BlueprintGraphTaskNode, 'tone' | 'createdAt' | 'updatedAt' | 'dispatchedAt'>,
    nowMs: number,
): TaskNodeTimeReading | undefined {
    const kind: TaskNodeTimeReading['kind'] = node.tone === 'running'
        ? 'running'
        : node.tone === 'completed' || node.tone === 'failed' || node.tone === 'cancelled'
            ? 'finished'
            : 'queued'
    const at = kind === 'running'
        ? (node.dispatchedAt || node.updatedAt || node.createdAt)
        : kind === 'finished' ? (node.updatedAt || node.createdAt) : node.createdAt
    if (!at) return undefined
    const parsed = Date.parse(at)
    if (!Number.isFinite(parsed)) return undefined
    return { kind, at, elapsedMs: Math.max(0, nowMs - parsed) }
}

/**
 * A pending task held by `not_before` in the FUTURE: the card says "held
 * until <time>" instead of a plain "pending" (tone stays neutral). Returns the
 * hold's epoch ms, or undefined when there is no live hold — a past
 * notBefore is an ordinary pending task again, and a stuck task stays stuck.
 */
export function taskHeldUntilMs(
    node: Pick<BlueprintGraphTaskNode, 'tone' | 'notBefore'>,
    nowMs: number,
): number | undefined {
    if (node.tone !== 'pending' || !node.notBefore) return undefined
    const at = Date.parse(node.notBefore)
    return Number.isFinite(at) && at > nowMs ? at : undefined
}
