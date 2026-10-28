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

/** Readable short id: known prefixes (mesh_queue:, task_, mission_) stripped, last 8 chars kept. */
export function shortMeshRefId(id: string): string {
    const bare = id.replace(/^mesh_queue:/, '').replace(/^(task|mission)_/, '')
    return bare.length > 8 ? bare.slice(-8) : bare
}

/** Task title from queue data; '' when unknown (the UI then shows a localized "Task …id"). */
export function meshArtifactTaskTitle(task: Pick<RepoMeshQueueTask, 'id' | 'message'> | undefined, _taskId: string): string {
    const text = task ? queueTaskDisplayText(task.message).split('\n')[0]!.trim() : ''
    if (!text) return ''
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
        if (mission?.id) missionTitle.set(mission.id, mission.title || '')
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
            title: isNone ? '' : missionTitle.get(missionKey) ?? '',
            newestAt: Math.max(...taskGroups.map(g => g.newestAt)),
            count: taskGroups.reduce((n, g) => n + g.items.length, 0),
            tasks: taskGroups,
        })
    }
    missions.sort((a, b) => (a.missionId === null ? 1 : 0) - (b.missionId === null ? 1 : 0) || b.newestAt - a.newestAt)

    const ordered = missions.flatMap(m => m.tasks.flatMap(g => g.items))
    return { missions, ordered, total: ordered.length }
}

const PREVIEW_MAX = 120
const clip = (text: string) => (text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text)

/** One-line list preview: diff → "+2 −1 · path", json → "{ a, b }", else first meaningful line. */
export function artifactPreviewLine(kind: ArtifactKind, previewText: string | undefined): string {
    const text = (previewText ?? '').replace(/\r\n/g, '\n')
    if (!text.trim()) return ''
    const lines = text.split('\n')
    if (kind === 'diff') {
        let add = 0
        let del = 0
        let file = ''
        for (const line of lines) {
            if (line.startsWith('+++') || line.startsWith('---')) {
                const m = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/.exec(line)
                if (!file && m && m[1] !== '/dev/null') file = m[1]!
            } else if (line.startsWith('+')) add += 1
            else if (line.startsWith('-')) del += 1
            else if (!file) {
                const g = /^diff --git a\/(\S+)/.exec(line)
                if (g) file = g[1]!
            }
        }
        return clip(`+${add} −${del}${file ? ` · ${file}` : ''}`)
    }
    if (kind === 'json') {
        try {
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) return `[ ${parsed.length} ]`
            if (parsed && typeof parsed === 'object') {
                const keys = Object.keys(parsed)
                return clip(`{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`)
            }
        } catch { /* truncated preview: fall through to text */ }
    }
    for (const raw of lines) {
        const line = raw.trim()
        if (!line || /^#{1,6}$/.test(line)) continue
        return clip(line.replace(/^#{1,6}\s+/, ''))
    }
    return ''
}
