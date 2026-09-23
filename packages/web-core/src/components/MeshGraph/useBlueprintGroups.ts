/**
 * useBlueprintGroups — the section model behind the blueprint LIST (P1 of the
 * canvas → list redesign, owner-approved 2026-09-16).
 *
 * The list answers the same question the fused canvas tried to: "what is
 * running, what is stuck on a human, what just finished". The canvas answered
 * it with geometry (ELK layers, hulls, an archive grid); the list answers it
 * with SECTIONS, which is what the 0.1-second read actually needs:
 *
 *   Running  — assigned (incl. live "generating" sessions) and dispatchable
 *              pending tasks. Full colour, pinned to the top.
 *   Blocked  — anything a human or an unmet dependency is holding: sessions
 *              awaiting approval/choice, system-blocked rows (blockedReason /
 *              dependencyFailures), pending rows waiting on unmet deps, and
 *              coordinator GATES in a blocking state (their own row kind).
 *   Recent   — the newest {@link BLUEPRINT_RECENT_TERMINAL_LIMIT} terminal
 *              rows, rendered muted/compact.
 *   History  — every older terminal row, behind an incremental load-more.
 *
 * Pure and deterministic (the hook is a thin useMemo wrapper) so the section
 * rules — the properties this redesign exists to pin — are unit-testable
 * without React Flow, ELK or a DOM.
 */
import { useMemo } from 'react'
import type { MeshGraphGateView, MeshGraphView, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import type { MeshTaskStatus } from '@adhdev/mesh-shared'
import { buildTaskDag } from './taskDagViewModel'

/** Terminal queue statuses — nothing in them will advance again on its own. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalTaskStatus(status: string): boolean {
    return TERMINAL_TASK_STATUSES.has(status)
}

/** The recent window: how many terminal rows render outside the History fold. */
export const BLUEPRINT_RECENT_TERMINAL_LIMIT = 10
/** How many additional History rows each load-more click reveals. */
export const BLUEPRINT_HISTORY_LOAD_STEP = 30

/**
 * True for a gate that is holding its graph and needs a human to act — the
 * one node class the blueprint exists to surface. Same vocabulary as the
 * daemon's gate lifecycle: declared/awaiting_coordinator/claimed/released/
 * cancelled/expired.
 */
export function isBlockingGateState(state: string): boolean {
    return state === 'awaiting_coordinator' || state === 'claimed' || state === 'expired'
}

/** What the assigned session is live-doing, joined via assignedSessionId. */
export interface BlueprintSessionActivity {
    generating: boolean
    awaitingApproval: boolean
    awaitingChoice: boolean
    /** Short human line (statusNote/title) for the blocked badge tooltip. */
    note?: string
}

/**
 * Join a task to its claiming session's live state. Substring matching over
 * state/chatStatus/lifecycle mirrors `derivePendingApprovals`
 * (PendingApprovalsInbox) so this list and the approvals inbox agree on what
 * counts as "awaiting approval".
 */
export function deriveSessionActivity(
    status: Pick<RepoMeshStatus, 'nodes'> | null | undefined,
    task: Pick<RepoMeshQueueTask, 'assignedSessionId' | 'assignedNodeId'>,
): BlueprintSessionActivity | undefined {
    const sessionId = task.assignedSessionId
    if (!sessionId) return undefined
    for (const node of status?.nodes ?? []) {
        if (task.assignedNodeId && node.nodeId !== task.assignedNodeId) continue
        for (const session of node.activeSessionDetails ?? []) {
            if (session?.sessionId !== sessionId) continue
            const text = `${session.state ?? ''} ${session.chatStatus ?? ''} ${session.lifecycle ?? ''}`.toLowerCase()
            return {
                generating: text.includes('generating'),
                awaitingApproval: text.includes('approval'),
                awaitingChoice: text.includes('choice'),
                ...(session.statusNote || session.title ? { note: session.statusNote ?? session.title ?? undefined } : {}),
            }
        }
    }
    return undefined
}

export type BlueprintSection = 'running' | 'blocked' | 'recent' | 'history'

/** One queue task, classified for the list. */
export interface BlueprintTaskRow {
    kind: 'task'
    section: BlueprintSection
    task: RepoMeshQueueTask
    /**
     * The status word the row leads with. Mostly the raw queue status;
     * 'generating' overrides 'assigned' when the claiming session is live
     * generating — the distinction the wireframe's 0.1-second read wants.
     */
    statusToken: 'generating' | MeshTaskStatus
    /** Unmet dependency ids (scheduler predicate — dep status !== completed). */
    waitingOn: string[]
    /** Referenced deps absent from the snapshot (warning badge). */
    missingDeps: string[]
    /** System hold text, when the daemon stamped one. */
    blockedReason?: string
    /** Count of failed/cancelled predecessors (C3 projection). */
    dependencyFailureCount: number
    awaitingApproval: boolean
    awaitingChoice: boolean
    /** Session note backing the approval/choice badge, when known. */
    sessionNote?: string
    /**
     * Where a "plan" mini-DAG can come from: a persistent graph WITH edges
     * that contains this task, or the task's own dependency edges in the
     * queue. Absent → the row renders no plan affordance at all.
     */
    planSource?: 'graph' | 'queue'
    /** The owning graph, when planSource === 'graph'. */
    planGraphId?: string
    /** Sort key: updatedAt || createdAt (ISO, lexicographic-safe). */
    timeKey: string
}

/** One blocking coordinator gate, presented as its own Blocked row. */
export interface BlueprintGateRow {
    kind: 'gate'
    section: 'blocked'
    graph: MeshGraphView
    nodeId: string
    gate?: MeshGraphGateView
    ref: string
    state: string
    /** Gates always belong to a graph; edges decide whether plan renders. */
    planSource?: 'graph'
    planGraphId?: string
    timeKey: string
}

export type BlueprintRow = BlueprintTaskRow | BlueprintGateRow

export interface BlueprintGroupCounts {
    running: number
    /** Task rows + gate rows in the Blocked section. */
    blocked: number
    recent: number
    history: number
    /** Distinct missions across ALL rows (terminal included). */
    missions: number
}

export interface BlueprintGroups {
    running: BlueprintTaskRow[]
    blocked: BlueprintRow[]
    recent: BlueprintTaskRow[]
    /** History rows already capped to the caller's limit. */
    history: BlueprintTaskRow[]
    /** Terminal rows beyond recent + the current history limit. */
    historyHiddenCount: number
    counts: BlueprintGroupCounts
}

function taskTimeKey(task: Pick<RepoMeshQueueTask, 'updatedAt' | 'createdAt'>): string {
    return String(task.updatedAt || task.createdAt || '')
}

/** taskId → owning graph, for graphs that actually HAVE edges. A graph with
 *  no edges has no plan to draw — the mini-DAG affordance must not appear. */
export function buildPlanGraphIndex(graphs: ReadonlyArray<MeshGraphView> | null | undefined): Map<string, MeshGraphView> {
    const index = new Map<string, MeshGraphView>()
    for (const graph of graphs ?? []) {
        if (!Array.isArray(graph.edges) || graph.edges.length === 0) continue
        for (const node of graph.nodes) {
            if (node.taskId && !index.has(node.taskId)) index.set(node.taskId, graph)
        }
    }
    return index
}

export function buildBlueprintGroups(
    tasks: RepoMeshQueueTask[] | null | undefined,
    status: Pick<RepoMeshStatus, 'nodes'> | null | undefined,
    graphs: ReadonlyArray<MeshGraphView> | null | undefined,
    historyLimit: number = BLUEPRINT_HISTORY_LOAD_STEP,
): BlueprintGroups {
    // The DAG projection is reused for its dependency derivations only
    // (waitingOn / missingDeps / blocked) — no layout, no edges rendered here.
    const dag = buildTaskDag(tasks)
    const planGraphByTaskId = buildPlanGraphIndex(graphs)
    // Tasks touched by at least one renderable dependency edge can draw a
    // queue-scoped plan even without a persistent graph.
    const edgeTouched = new Set<string>()
    for (const edge of dag.edges) {
        edgeTouched.add(edge.source)
        edgeTouched.add(edge.target)
    }

    const running: BlueprintTaskRow[] = []
    const blockedTasks: BlueprintTaskRow[] = []
    const terminal: BlueprintTaskRow[] = []
    const missionIds = new Set<string>()

    for (const node of dag.nodes) {
        const task = node.task
        if (typeof task.missionId === 'string' && task.missionId) missionIds.add(task.missionId)
        const activity = task.status === 'assigned' ? deriveSessionActivity(status, task) : undefined
        const planGraph = planGraphByTaskId.get(task.id)
        const planSource: BlueprintTaskRow['planSource'] = planGraph ? 'graph' : edgeTouched.has(task.id) ? 'queue' : undefined
        const isTerminal = isTerminalTaskStatus(task.status)
        const blockedReason = typeof task.blockedReason === 'string' && task.blockedReason ? task.blockedReason : undefined
        const awaitingApproval = Boolean(activity?.awaitingApproval)
        const awaitingChoice = Boolean(activity?.awaitingChoice && !activity?.awaitingApproval)
        // Blocked means "will not advance without a human or an upstream
        // change": a live approval/choice hold, a system block, failed
        // upstream, or unmet deps. Terminal rows are never blocked — whatever
        // held them is history now.
        const isBlocked = !isTerminal && (
            awaitingApproval || awaitingChoice || Boolean(blockedReason)
            || node.waitingOn.length > 0 || (task.dependencyFailures?.length ?? 0) > 0
        )
        const row: BlueprintTaskRow = {
            kind: 'task',
            section: isTerminal ? 'history' : isBlocked ? 'blocked' : 'running',
            task,
            statusToken: activity?.generating ? 'generating' : task.status,
            waitingOn: node.waitingOn,
            missingDeps: node.missingDeps,
            ...(blockedReason ? { blockedReason } : {}),
            dependencyFailureCount: task.dependencyFailures?.length ?? 0,
            awaitingApproval,
            awaitingChoice,
            ...(activity?.note ? { sessionNote: activity.note } : {}),
            ...(planSource ? { planSource } : {}),
            ...(planGraph ? { planGraphId: planGraph.graphId } : {}),
            timeKey: taskTimeKey(task),
        }
        if (isTerminal) terminal.push(row)
        else if (isBlocked) blockedTasks.push(row)
        else running.push(row)
    }

    // Running: live work first (generating, then assigned), queued after,
    // newest first within each band — the top of the list is what moves.
    const runningRank = (row: BlueprintTaskRow): number =>
        row.statusToken === 'generating' ? 0 : row.statusToken === 'assigned' ? 1 : 2
    running.sort((a, b) => {
        const rank = runningRank(a) - runningRank(b)
        if (rank !== 0) return rank
        return b.timeKey.localeCompare(a.timeKey)
    })

    // Blocked: human-holds (approval/choice) outrank dependency waits — they
    // are the ones a person can actually clear right now. Gates lead the
    // section for the same reason.
    const blockedRank = (row: BlueprintRow): number => {
        if (row.kind === 'gate') return 0
        if (row.awaitingApproval || row.awaitingChoice) return 1
        if (row.blockedReason || row.dependencyFailureCount > 0) return 2
        return 3
    }
    const gateRows: BlueprintGateRow[] = []
    for (const graph of graphs ?? []) {
        const hasEdges = Array.isArray(graph.edges) && graph.edges.length > 0
        for (const gate of graph.gates ?? []) {
            if (!isBlockingGateState(gate.state)) continue
            const graphNode = graph.nodes.find(candidate => candidate.nodeId === gate.nodeId)
            gateRows.push({
                kind: 'gate',
                section: 'blocked',
                graph,
                nodeId: gate.nodeId,
                gate,
                ref: graphNode?.ref || gate.nodeId.slice(0, 8),
                state: gate.state,
                ...(hasEdges ? { planSource: 'graph' as const, planGraphId: graph.graphId } : {}),
                timeKey: String(graph.terminalAt || graph.createdAt || ''),
            })
        }
        if (typeof graph.missionId === 'string' && graph.missionId) missionIds.add(graph.missionId)
    }
    const blocked: BlueprintRow[] = [...gateRows, ...blockedTasks]
    blocked.sort((a, b) => {
        const rank = blockedRank(a) - blockedRank(b)
        if (rank !== 0) return rank
        return b.timeKey.localeCompare(a.timeKey)
    })

    // Terminal rows, newest first: the first RECENT_LIMIT are the Recent
    // strip, the rest fold into History behind the caller's limit.
    terminal.sort((a, b) => b.timeKey.localeCompare(a.timeKey))
    const recent = terminal.slice(0, BLUEPRINT_RECENT_TERMINAL_LIMIT).map(row => ({ ...row, section: 'recent' as const }))
    const olderTerminal = terminal.slice(BLUEPRINT_RECENT_TERMINAL_LIMIT)
    const history = olderTerminal.slice(0, Math.max(0, historyLimit))

    return {
        running,
        blocked,
        recent,
        history,
        historyHiddenCount: Math.max(0, olderTerminal.length - history.length),
        counts: {
            running: running.length,
            blocked: blocked.length,
            recent: recent.length,
            history: olderTerminal.length,
            missions: missionIds.size,
        },
    }
}

/* ── By-mission regrouping (P1 scope: group headers, nothing more) ───────── */

export interface BlueprintMissionGroup {
    /** Mission id, or null for the ad-hoc bucket (rows without a mission). */
    missionId: string | null
    title: string | null
    rows: BlueprintRow[]
    /** Latest timeKey in the group — groups order by activity. */
    lastActivityAt: string
    /** True when the group holds at least one running/blocked row. */
    hasLiveWork: boolean
}

/**
 * Regroup the visible rows by mission. The section model survives INSIDE each
 * group as row order (running → blocked → recent → history), so flipping "By
 * mission" reorders the list without changing what is visible.
 */
export function buildBlueprintMissionGroups(
    rows: ReadonlyArray<BlueprintRow>,
    missionTitles: Readonly<Record<string, string>> | undefined,
): BlueprintMissionGroup[] {
    const sectionRank: Record<BlueprintSection, number> = { running: 0, blocked: 1, recent: 2, history: 3 }
    const byMission = new Map<string | null, BlueprintRow[]>()
    for (const row of rows) {
        const missionId = row.kind === 'task'
            ? (typeof row.task.missionId === 'string' && row.task.missionId ? row.task.missionId : null)
            : (typeof row.graph.missionId === 'string' && row.graph.missionId ? row.graph.missionId : null)
        const bucket = byMission.get(missionId)
        if (bucket) bucket.push(row)
        else byMission.set(missionId, [row])
    }
    const groups: BlueprintMissionGroup[] = []
    for (const [missionId, groupRows] of byMission) {
        const ordered = [...groupRows].sort((a, b) => {
            const rank = sectionRank[a.section] - sectionRank[b.section]
            if (rank !== 0) return rank
            return b.timeKey.localeCompare(a.timeKey)
        })
        let lastActivityAt = ''
        let hasLiveWork = false
        for (const row of groupRows) {
            if (row.timeKey > lastActivityAt) lastActivityAt = row.timeKey
            if (row.section === 'running' || row.section === 'blocked') hasLiveWork = true
        }
        groups.push({
            missionId,
            title: missionId ? missionTitles?.[missionId] ?? null : null,
            rows: ordered,
            lastActivityAt,
            hasLiveWork,
        })
    }
    groups.sort((a, b) => {
        const live = (b.hasLiveWork ? 1 : 0) - (a.hasLiveWork ? 1 : 0)
        if (live !== 0) return live
        return b.lastActivityAt.localeCompare(a.lastActivityAt)
    })
    return groups
}

export function useBlueprintGroups(
    tasks: RepoMeshQueueTask[],
    status: Pick<RepoMeshStatus, 'nodes'> | null | undefined,
    graphs: ReadonlyArray<MeshGraphView> | null | undefined,
    historyLimit: number,
): BlueprintGroups {
    return useMemo(
        () => buildBlueprintGroups(tasks, status, graphs, historyLimit),
        [tasks, status, graphs, historyLimit],
    )
}
