/**
 * Task-DAG view model — pure projection of mesh queue tasks into a dependency
 * graph (nodes = tasks, edges = `dependsOn`). Companion to mesh-visualization's
 * machine/worktree topology graph: that one answers "where does work run",
 * this one answers "in what order does work run".
 *
 * View-time only: dependency state is DERIVED here from task statuses (mirroring
 * daemon-core's describeTaskDependencyState semantics — an edge is satisfied iff
 * the dependency task is 'completed'), never stored. Pure and deterministic so it
 * can be unit-tested without React Flow.
 */

import type { RepoMeshQueueTask } from '@adhdev/daemon-core'

export type TaskDagEdgeState = 'satisfied' | 'waiting' | 'failed'

export interface TaskDagNode {
    id: string
    task: RepoMeshQueueTask
    /** Dependency ids present in the projected task set (renderable edges). */
    dependsOn: string[]
    /**
     * Dependency ids referenced by the task but absent from the queue snapshot
     * (e.g. a foreign id typo'd via single enqueueTask, which tolerates dangling
     * deps). Surfaced as a warning badge instead of a broken edge.
     */
    missingDeps: string[]
    /** Unmet dependency ids — same predicate as the scheduler: dep status !== 'completed'. */
    waitingOn: string[]
    /** True when the daemon stamped a system block (e.g. "dependency_failed:<id>"). */
    blocked: boolean
}

export interface TaskDagEdge {
    id: string
    /** The dependency (runs first). */
    source: string
    /** The dependent (runs after source completes). */
    target: string
    state: TaskDagEdgeState
}

export interface TaskDagStats {
    total: number
    edges: number
    pending: number
    assigned: number
    completed: number
    failed: number
    cancelled: number
    /** Tasks currently gated behind at least one unmet dependency. */
    waiting: number
    /** Tasks carrying a blockedReason (dependency-failure block policy). */
    blocked: number
    /** Distinct missions represented in the task set. */
    missions: number
}

export interface TaskDagData {
    nodes: TaskDagNode[]
    edges: TaskDagEdge[]
    stats: TaskDagStats
}

function normalizeDeps(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of value) {
        const id = typeof raw === 'string' ? raw.trim() : ''
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    return out
}

/** Edge state from the dependency task's status (absent dep never reaches here). */
function edgeState(depStatus: string | undefined): TaskDagEdgeState {
    if (depStatus === 'completed') return 'satisfied'
    if (depStatus === 'failed' || depStatus === 'cancelled') return 'failed'
    return 'waiting'
}

export function buildTaskDag(tasks: RepoMeshQueueTask[] | null | undefined): TaskDagData {
    const list = Array.isArray(tasks) ? tasks.filter(task => task && typeof task.id === 'string' && task.id) : []
    const statusById = new Map<string, string>(list.map(task => [task.id, task.status]))

    const nodes: TaskDagNode[] = []
    const edges: TaskDagEdge[] = []
    const missionIds = new Set<string>()
    let waitingCount = 0
    let blockedCount = 0
    const statusCounts: Record<string, number> = { pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0 }

    for (const task of list) {
        const deps = normalizeDeps(task.dependsOn)
        const present: string[] = []
        const missing: string[] = []
        const waitingOn: string[] = []
        for (const dep of deps) {
            if (!statusById.has(dep)) {
                missing.push(dep)
                // A dep absent from the snapshot is unmet by the scheduler's rules
                // (taskDependenciesSatisfied treats a missing id as unsatisfied).
                if (task.status === 'pending') waitingOn.push(dep)
                continue
            }
            present.push(dep)
            edges.push({
                id: `dep:${dep}->${task.id}`,
                source: dep,
                target: task.id,
                state: edgeState(statusById.get(dep)),
            })
            if (task.status === 'pending' && statusById.get(dep) !== 'completed') waitingOn.push(dep)
        }
        const blocked = typeof task.blockedReason === 'string' && task.blockedReason.length > 0
        if (blocked) blockedCount += 1
        if (waitingOn.length > 0) waitingCount += 1
        if (typeof task.missionId === 'string' && task.missionId) missionIds.add(task.missionId)
        if (task.status in statusCounts) statusCounts[task.status] += 1
        nodes.push({ id: task.id, task, dependsOn: present, missingDeps: missing, waitingOn, blocked })
    }

    return {
        nodes,
        edges,
        stats: {
            total: nodes.length,
            edges: edges.length,
            pending: statusCounts.pending,
            assigned: statusCounts.assigned,
            completed: statusCounts.completed,
            failed: statusCounts.failed,
            cancelled: statusCounts.cancelled,
            waiting: waitingCount,
            blocked: blockedCount,
            missions: missionIds.size,
        },
    }
}
