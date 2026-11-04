import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'

export function QueueTaskHold({ task, nowMs = Date.now() }: { task: RepoMeshQueueTask; nowMs?: number }) {
    const { t } = useTranslation('common')
    if (task.status !== 'pending' || !task.hold) return null
    const hold = task.hold
    const ageMinutes = Math.max(0, Math.floor((nowMs - Date.parse(hold.since)) / 60_000)) || 0
    const blockers = hold.blockingTaskIds.map(id => {
        const title = hold.blockingTasks?.find(other => other.taskId === id)?.title
        return title ? `${title} (${id})` : id
    }).join(', ')
    const detail = hold.detail as { unknownField?: string; canonicalResource?: string; resolution?: string; message?: string; overlappingPaths?: Array<{ taskId: string; ownedPath: string; blockingPath: string }> } | undefined
    // The conflicting pair, so "held by task X" also says which path or shared resource collides.
    const pairs = (detail?.overlappingPaths ?? []).slice(0, 2).map(pair => pair.ownedPath === pair.blockingPath ? pair.ownedPath : `${pair.ownedPath} ↔ ${pair.blockingPath}`)
    const more = (detail?.overlappingPaths?.length ?? 0) > 2 ? ` +${(detail?.overlappingPaths?.length ?? 0) - 2}` : ''
    const extra = [pairs.length ? pairs.join(', ') + more : '', detail?.unknownField, detail?.canonicalResource, detail?.resolution, detail?.message].filter(Boolean).join(' · ')
    return (
        <div className="text-3xs text-status-warning" title={JSON.stringify(hold.detail)}>
            {t(blockers ? 'mesh.overview.taskHeldBy' : 'mesh.overview.taskHeld', { reason: hold.reason, task: blockers })}
            {extra ? ` · ${extra}` : ''}
            {' · '}{t('mesh.overview.taskHeldAge', { count: ageMinutes })}
        </div>
    )
}
