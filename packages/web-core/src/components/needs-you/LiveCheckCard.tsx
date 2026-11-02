/**
 * Live-check card (Needs You / To do): the owner's one-tap verdict on a post-deploy check.
 * "Works" closes the item with an evidence line; "Doesn't work" keeps it visible as failed (the
 * coordinator is told through the mission). An optional one-line note is stored with the result.
 * The result is recorded on the hosting daemon only (`mission_live_check_resolve`).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '../ui/Button'
import { ProjectMissionLine } from './DecisionCard'
import type { NeedsYouLiveCheck } from './needs-you-model'
import type { NeedsYouOutcome } from '../../context/NeedsYouContext'

export default function LiveCheckCard({ check, projectName, busy, outcome, onResolve, onOpenMission }: {
    check: NeedsYouLiveCheck
    projectName?: string
    busy: boolean
    outcome?: NeedsYouOutcome
    onResolve: (verdict: 'works' | 'doesnt_work', note: string) => void
    onOpenMission?: () => void
}) {
    const { t } = useTranslation('common')
    const [note, setNote] = useState('')
    const failed = check.state === 'failed'
    return (
        <div data-testid="needs-you-live-check" data-live-check-state={failed ? 'failed' : 'open'} className="rounded-lg border border-border-subtle p-3 flex flex-col gap-1.5 bg-bg-panel">
            <div className="flex items-center gap-1.5">
                <span className="rounded px-1.5 py-0.5 text-3xs font-semibold bg-bg-secondary text-text-muted">{t('needsYou.kinds.live_check')}</span>
                {check.machine && <span className="text-3xs text-text-muted">{check.machine}</span>}
                {failed && (
                    <span data-testid="needs-you-live-check-failed" className="rounded px-1.5 py-0.5 text-3xs font-bold" style={{ background: 'color-mix(in srgb, var(--status-danger) 18%, transparent)', color: 'var(--status-danger)' }}>
                        {t('needsYou.liveCheckFailedBadge')}
                    </span>
                )}
            </div>
            <ProjectMissionLine meshId={check.meshId} missionTitle={check.missionTitle} carryOver={check.carryOver} projectName={projectName} onOpenMission={onOpenMission} />
            <div className="text-sm text-text-primary">{check.text}</div>
            <input
                className="input text-xs"
                data-testid="needs-you-live-check-note"
                type="text"
                maxLength={200}
                value={note}
                disabled={busy}
                placeholder={t('needsYou.liveCheckNotePlaceholder')}
                aria-label={t('needsYou.liveCheckNotePlaceholder')}
                onChange={e => setNote(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" className="min-h-[44px] md:min-h-0" data-testid="needs-you-live-check-works" disabled={busy} onClick={() => onResolve('works', note.trim())}>
                    {t('needsYou.liveCheckWorks')}
                </Button>
                <Button size="sm" variant="danger" className="min-h-[44px] md:min-h-0" data-testid="needs-you-live-check-fails" disabled={busy} onClick={() => onResolve('doesnt_work', note.trim())}>
                    {t('needsYou.liveCheckDoesntWork')}
                </Button>
            </div>
            {busy && <div className="text-2xs text-text-muted" role="status" data-testid="needs-you-sending">{t('needsYou.sending')}</div>}
            {outcome && !outcome.ok && (
                <div role="alert" className="text-xs" style={{ color: 'var(--status-danger)' }}>{t('needsYou.liveCheckResolveFailed', { code: outcome.code ?? 'failed' })}</div>
            )}
        </div>
    )
}
