import type { ArtifactKind, ChatAttachmentMeta, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { queueTaskDisplayText } from '../../utils/queue-task-label'

/** Pure view-model for the mesh Artifacts tab: filter → group (mission → task) → used-by join. */

export type MeshArtifactKindFilter = 'all' | ArtifactKind

export interface MeshArtifactTaskRef {
    taskId: string
    title: string
}

export interface MeshArtifactItem {
    attachment: ChatAttachmentMeta
    /** Tasks whose `inputArtifactIds` include this artifact. */
    usedBy: MeshArtifactTaskRef[]
}

export interface MeshArtifactTaskGroup {
    /** Producing task id; null when the artifact carries no task. */
    taskId: string | null
    title: string
    producerRole: string | null
    sessionId: string | null
    newestAt: number
    items: MeshArtifactItem[]
}

export interface MeshArtifactMissionGroup {
    /** null = artifacts with no mission (always rendered last). */
    missionId: string | null
    title: string
    newestAt: number
    count: number
    tasks: MeshArtifactTaskGroup[]
}

export interface MeshArtifactsView {
    missions: MeshArtifactMissionGroup[]
    /** Every visible artifact in display order — the viewer's prev/next sequence. */
    ordered: MeshArtifactItem[]
    total: number
}

export interface MeshArtifactsViewInput {
    attachments: readonly ChatAttachmentMeta[]
    tasks: readonly RepoMeshQueueTask[]
    missions?: RepoMeshStatus['missions']
    kind: MeshArtifactKindFilter
    query: string
}

const TASK_TITLE_MAX = 90

export function meshArtifactTaskTitle(task: Pick<RepoMeshQueueTask, 'id' | 'message'> | undefined, taskId: string): string {
    const text = task ? queueTaskDisplayText(task.message).split('\n')[0]!.trim() : ''
    if (!text) return `#${taskId.slice(0, 8)}`
    return text.length > TASK_TITLE_MAX ? `${text.slice(0, TASK_TITLE_MAX - 1)}…` : text
}

export function matchesMeshArtifactQuery(att: ChatAttachmentMeta, query: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [att.title, att.filename, att.previewText].some(v => typeof v === 'string' && v.toLowerCase().includes(q))
}

export function buildMeshArtifactsView(input: MeshArtifactsViewInput): MeshArtifactsView {
    const taskById = new Map<string, RepoMeshQueueTask>()
    const usedByMap = new Map<string, MeshArtifactTaskRef[]>()
    for (const task of input.tasks) {
        taskById.set(task.id, task)
        for (const artifactId of task.inputArtifactIds ?? []) {
            const list = usedByMap.get(artifactId) ?? []
            if (!list.some(ref => ref.taskId === task.id)) list.push({ taskId: task.id, title: meshArtifactTaskTitle(task, task.id) })
            usedByMap.set(artifactId, list)
        }
    }
    const missionTitle = new Map<string, string>()
    for (const mission of input.missions ?? []) {
        if (mission?.id) missionTitle.set(mission.id, mission.title || mission.id)
    }

    const visible = input.attachments.filter(att =>
        (input.kind === 'all' || att.kind === input.kind) && matchesMeshArtifactQuery(att, input.query))

    const missionGroups = new Map<string, Map<string, MeshArtifactTaskGroup>>()
    const NO_MISSION = '\u0000none'
    const NO_TASK = '\u0000none'
    for (const att of visible) {
        const task = att.taskId ? taskById.get(att.taskId) : undefined
        const missionKey = att.missionId || task?.missionId || NO_MISSION
        const taskKey = att.taskId || NO_TASK
        let tasks = missionGroups.get(missionKey)
        if (!tasks) missionGroups.set(missionKey, (tasks = new Map()))
        let group = tasks.get(taskKey)
        if (!group) {
            group = {
                taskId: att.taskId ?? null,
                title: att.taskId ? meshArtifactTaskTitle(task, att.taskId) : '',
                producerRole: att.producerRole ?? null,
                sessionId: att.originSessionId ?? null,
                newestAt: 0,
                items: [],
            }
            tasks.set(taskKey, group)
        }
        group.items.push({ attachment: att, usedBy: usedByMap.get(att.artifactId) ?? [] })
        group.newestAt = Math.max(group.newestAt, att.createdAt)
    }

    const missions: MeshArtifactMissionGroup[] = []
    for (const [missionKey, tasks] of missionGroups) {
        const taskGroups = [...tasks.values()]
        for (const g of taskGroups) g.items.sort((a, b) => b.attachment.createdAt - a.attachment.createdAt)
        // Task groups newest first; the "no task" group last within its mission.
        taskGroups.sort((a, b) => (a.taskId === null ? 1 : 0) - (b.taskId === null ? 1 : 0) || b.newestAt - a.newestAt)
        const isNone = missionKey === NO_MISSION
        missions.push({
            missionId: isNone ? null : missionKey,
            title: isNone ? '' : missionTitle.get(missionKey) ?? `#${missionKey.slice(0, 8)}`,
            newestAt: Math.max(...taskGroups.map(g => g.newestAt)),
            count: taskGroups.reduce((n, g) => n + g.items.length, 0),
            tasks: taskGroups,
        })
    }
    missions.sort((a, b) => (a.missionId === null ? 1 : 0) - (b.missionId === null ? 1 : 0) || b.newestAt - a.newestAt)

    const ordered = missions.flatMap(m => m.tasks.flatMap(g => g.items))
    return { missions, ordered, total: ordered.length }
}
