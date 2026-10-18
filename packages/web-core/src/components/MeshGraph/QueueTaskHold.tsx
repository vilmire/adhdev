import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'

export function QueueTaskHold({ task, nowMs = Date.now() }: { task: RepoMeshQueueTask; nowMs?: number }) {
    const { t } = useTranslation('common')
    if (task.status !== 'pending' || !task.hold) return null
    const hold = task.hold
    const ageMinutes = Math.max(0, Math.floor((nowMs - Date.parse(hold.since)) / 60_000)) || 0
    const blockers = hold.blockingTaskIds.map(id => {
        const title = hold.blockingTasks?.find(other => other.taskId === id)?.title
        return title ? `${title} (${id.slice(0, 8)})` : id.slice(0, 8)
    }).join(', ')
    return (
        <div className="text-3xs text-status-warning" title={JSON.stringify(hold.detail)}>
            {t(blockers ? 'mesh.overview.taskHeldBy' : 'mesh.overview.taskHeld', { reason: hold.reason, task: blockers })}
            {' · '}{t('mesh.overview.taskHeldAge', { count: ageMinutes })}
        </div>
    )
}
