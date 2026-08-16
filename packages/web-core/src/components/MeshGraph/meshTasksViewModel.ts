/**
 * Mission-centric projection of the mesh work queue for the Tasks tab.
 *
 * The queue's dominant structure is "missions over time", not dependency
 * topology — most tasks carry a missionId and no dependsOn — so the primary
 * grouping is by mission, with the dependency DAG demoted to an opt-in
 * per-mission drill-down (only offered when the mission actually has edges).
 * Pure and deterministic: no React, unit-testable directly.
 */

import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { scopeTaskDagTasks, TASK_DAG_RECENT_TERMINAL_LIMIT } from './taskDagViewModel'

export interface MissionTaskCounts {
    total: number
    assigned: number
    pending: number
    completed: number
    failed: number
    cancelled: number
    /** Pending tasks stamped with a dependency-failure blockedReason. */
    blocked: number
}

export interface MissionTaskGroup {
    /** Mission id, or null for the ad-hoc bucket (tasks without a missionId). */
    missionId: string | null
    /** Mission title when the status payload knows it; null → render fallback. */
    title: string | null
    /** Mission lifecycle status when known (active/paused/completed/abandoned). */
    missionStatus: string | null
    /** Mission goal text (full or slim preview, whichever the payload carries). */
    goal: string | null
    /** Scoped tasks, display-ordered: running → queued → failed → done → cancelled. */
    tasks: RepoMeshQueueTask[]
    counts: MissionTaskCounts
    /** True when at least one scoped task in this group has a renderable dependsOn edge. */
    hasDependencies: boolean
    /** Latest updatedAt across the group's scoped tasks ('' with none). */
    lastActivityAt: string
}

export interface MeshTasksViewData {
    /** Currently assigned (running) tasks across all missions. */
    running: RepoMeshQueueTask[]
    /** Needs-attention set: failed tasks in scope + dependency-blocked pending tasks. */
    attention: RepoMeshQueueTask[]
    /** Mission groups (ad-hoc bucket included, when present), activity-ordered. */
    groups: MissionTaskGroup[]
    /** Terminal rows excluded by the history cap. */
    hiddenCount: number
    /** Totals over the scoped set, for the summary chips. */
    counts: MissionTaskCounts
}

const STATUS_DISPLAY_RANK: Record<string, number> = {
    assigned: 0,
    pending: 1,
    failed: 2,
    completed: 3,
    cancelled: 4,
}

function statusRank(status: string): number {
    return STATUS_DISPLAY_RANK[status] ?? 5
}

function taskTime(task: RepoMeshQueueTask): string {
    return String(task.updatedAt || task.createdAt || '')
}

function isBlocked(task: RepoMeshQueueTask): boolean {
    return typeof task.blockedReason === 'string' && task.blockedReason.length > 0
}

function countTasks(tasks: RepoMeshQueueTask[]): MissionTaskCounts {
    const counts: MissionTaskCounts = { total: 0, assigned: 0, pending: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 }
    for (const task of tasks) {
        counts.total += 1
        if (task.status === 'assigned') counts.assigned += 1
        else if (task.status === 'pending') counts.pending += 1
        else if (task.status === 'completed') counts.completed += 1
        else if (task.status === 'failed') counts.failed += 1
        else if (task.status === 'cancelled') counts.cancelled += 1
        if (task.status === 'pending' && isBlocked(task)) counts.blocked += 1
    }
    return counts
}

/** Missions list from the status payload (slim or full summaries), by id. */
function missionInfoById(status: Pick<RepoMeshStatus, 'missions'> | null | undefined): Map<string, { title: string; status: string; goal: string }> {
    const out = new Map<string, { title: string; status: string; goal: string }>()
    for (const mission of status?.missions ?? []) {
        if (!mission || typeof mission.id !== 'string' || !mission.id) continue
        // Compact payloads carry goalPreview instead of goal (slim summaries).
        const anyMission = mission as { goal?: unknown; goalPreview?: unknown }
        const goal = typeof anyMission.goal === 'string' && anyMission.goal
            ? anyMission.goal
            : typeof anyMission.goalPreview === 'string' ? anyMission.goalPreview : ''
        out.set(mission.id, {
            title: typeof mission.title === 'string' ? mission.title : '',
            status: typeof mission.status === 'string' ? mission.status : '',
            goal,
        })
    }
    return out
}

export function buildMeshTasksView(
    tasks: RepoMeshQueueTask[] | null | undefined,
    status: Pick<RepoMeshStatus, 'missions'> | null | undefined,
    terminalLimit: number = TASK_DAG_RECENT_TERMINAL_LIMIT,
): MeshTasksViewData {
    // Same history cap as the old DAG view: active tasks + their dependency
    // ancestry always render; terminal rows are capped, revealed via load-more.
    const scoped = scopeTaskDagTasks(tasks, terminalLimit)
    const list = scoped.tasks
    const idsInScope = new Set(list.map(task => task.id))
    const missions = missionInfoById(status)

    const byMission = new Map<string | null, RepoMeshQueueTask[]>()
    for (const task of list) {
        const key = typeof task.missionId === 'string' && task.missionId ? task.missionId : null
        const bucket = byMission.get(key)
        if (bucket) bucket.push(task)
        else byMission.set(key, [task])
    }

    const groups: MissionTaskGroup[] = []
    for (const [missionId, groupTasks] of byMission) {
        const ordered = [...groupTasks].sort((a, b) => {
            const rank = statusRank(a.status) - statusRank(b.status)
            if (rank !== 0) return rank
            return taskTime(b).localeCompare(taskTime(a))
        })
        const info = missionId ? missions.get(missionId) : undefined
        let lastActivityAt = ''
        let hasDependencies = false
        for (const task of groupTasks) {
            const time = taskTime(task)
            if (time > lastActivityAt) lastActivityAt = time
            if (!hasDependencies && Array.isArray(task.dependsOn) && task.dependsOn.some(dep => typeof dep === 'string' && idsInScope.has(dep))) {
                hasDependencies = true
            }
        }
        groups.push({
            missionId,
            title: info?.title || null,
            missionStatus: info?.status || null,
            goal: info?.goal || null,
            tasks: ordered,
            counts: countTasks(groupTasks),
            hasDependencies,
            lastActivityAt,
        })
    }

    // Activity order: groups with running work first, then most recent activity.
    groups.sort((a, b) => {
        const active = (b.counts.assigned > 0 ? 1 : 0) - (a.counts.assigned > 0 ? 1 : 0)
        if (active !== 0) return active
        return b.lastActivityAt.localeCompare(a.lastActivityAt)
    })

    const running = list
        .filter(task => task.status === 'assigned')
        .sort((a, b) => taskTime(b).localeCompare(taskTime(a)))
    const attention = list
        .filter(task => task.status === 'failed' || (task.status === 'pending' && isBlocked(task)))
        .sort((a, b) => taskTime(b).localeCompare(taskTime(a)))

    return {
        running,
        attention,
        groups,
        hiddenCount: scoped.hiddenCount,
        counts: countTasks(list),
    }
}
