/**
 * One owner-decision card (design §6.2/§6.4): question, context, option buttons (the
 * recommended one highlighted), free-text input, project + mission link, source badge,
 * due / auto-apply label and a blocking badge. The same card serves the coordinator's
 * "closed as owner abandoned — correct?" confirmation (Correct / Reopen).
 *
 * `preselect` (deep link `?choose=`) marks an option as picked and offers a single Confirm
 * tap. Swipe (touch): right = answer with the recommended option, left = later.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import Button from '../ui/Button'
import { getMeshName } from '../../utils/mesh-name-registry'
import {
    dueInfo,
    formatSpan,
    confirmationOptionKey,
    isCloseConfirmation,
    missionDisplayTitle,
    parseCloseConfirmationContext,
    type NeedsYouAnswered,
    type NeedsYouDecision,
    type NeedsYouOption,
} from './needs-you-model'
import { mayAlreadyBeInProgress, describeAnswer } from './needs-you-model'
import { useSwipe } from './useSwipe'
import type { TFunction } from 'i18next'
import type { NeedsYouOutcome } from '../../context/NeedsYouContext'

export interface DecisionCardProps {
    decision: NeedsYouDecision
    confirmation?: boolean
    busy?: boolean
    outcome?: NeedsYouOutcome
    nowMs: number
    projectName?: string
    /** Option id picked by a deep link: shown as chosen, answered by one Confirm tap. */
    preselect?: string
    highlighted?: boolean
    onAnswer: (input: { optionId?: string; text?: string }, opts?: { swipe?: boolean }) => void
    onLater?: () => void
    onOpenMission?: () => void
}

/**
 * Close-confirmation text through the locale (stored canonical text stays English): question, the
 * mission title + reason without its id, and the two option labels. Other cards pass through.
 */
export function localizeConfirmation(t: TFunction, d: { question: string; context?: string; options: NeedsYouOption[] }, confirmation: boolean): { question: string; context?: string; options: NeedsYouOption[] } {
    if (!confirmation) return d
    const parsed = parseCloseConfirmationContext(d.context)
    return {
        question: t('needsYou.confirm.question'),
        context: parsed
            ? (parsed.reason ? t('needsYou.confirm.contextWithReason', { title: parsed.title, reason: parsed.reason }) : t('needsYou.confirm.context', { title: parsed.title }))
            : d.context,
        options: d.options.map(o => {
            const key = confirmationOptionKey(o.label)
            return key ? { ...o, label: t(`needsYou.confirm.${key}`) } : o
        }),
    }
}

export function ProjectMissionLine({ meshId, missionTitle, carryOver, projectName, onOpenMission }: {
    meshId: string; missionTitle: string; carryOver?: boolean; projectName?: string; onOpenMission?: () => void
}) {
    const { t } = useTranslation('common')
    const project = projectName ?? getMeshName(meshId) ?? meshId.slice(0, 8)
    const title = missionDisplayTitle({ title: missionTitle, carryOver }, t('needsYou.carryOverTitle'))
    return (
        <div className="flex flex-wrap items-center gap-x-2 text-2xs text-text-muted">
            <span className="font-semibold">{project}</span>
            {title && (onOpenMission
                ? <button type="button" className="underline decoration-dotted hover:text-text-primary truncate max-w-full" onClick={onOpenMission}>{title}</button>
                : <span className="truncate">{title}</span>)}
        </div>
    )
}

export default function DecisionCard({
    decision, confirmation, busy, outcome, nowMs, projectName, preselect, highlighted, onAnswer, onLater, onOpenMission,
}: DecisionCardProps) {
    const { t } = useTranslation('common')
    const [picked, setPicked] = useState<string | undefined>(preselect)
    const [text, setText] = useState('')
    const rootRef = useRef<HTMLDivElement>(null)
    useEffect(() => { setPicked(preselect) }, [preselect])
    useEffect(() => {
        if (highlighted) rootRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }, [highlighted])

    const shown = localizeConfirmation(t, decision, confirmation === true)
    const recommended = decision.options.find(o => o.id === decision.recommended)
    const due = dueInfo(decision, nowMs)
    const swipe = useSwipe({
        enabled: !busy,
        onRight: recommended && !confirmation ? () => onAnswer({ optionId: recommended.id }, { swipe: true }) : undefined,
        onLeft: onLater,
    })
    const pickedOption = shown.options.find(o => o.id === picked)
    const choose = (id: string) => {
        if (busy) return
        if (preselect !== undefined) setPicked(id)   // deep-linked: choosing only selects, Confirm answers
        else onAnswer({ optionId: id })
    }
    const sendText = () => {
        const v = text.trim()
        if (!v || busy) return
        onAnswer({ text: v })
        setText('')
    }

    return (
        <div
            ref={rootRef}
            data-testid="needs-you-decision-card"
            data-decision-id={decision.itemId}
            className={cn('rounded-lg border p-3 flex flex-col gap-2 bg-bg-panel touch-pan-y', highlighted ? 'border-accent-primary ring-1 ring-accent-primary' : 'border-border-subtle')}
            style={swipe.offset ? { transform: `translateX(${swipe.offset}px)`, transition: 'none' } : undefined}
            {...swipe.handlers}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                {decision.urgency === 'blocking' && (
                    <span className="rounded px-1.5 py-0.5 text-3xs font-bold uppercase" style={{ background: 'color-mix(in srgb, var(--status-error) 18%, transparent)', color: 'var(--status-error)' }}>{t('needsYou.blocking')}</span>
                )}
                <span className="rounded px-1.5 py-0.5 text-3xs font-semibold bg-bg-secondary text-text-muted">
                    {decision.source === 'worker' ? t('needsYou.sourceWorker') : decision.source === 'daemon' ? t('needsYou.sourceDaemon') : t('needsYou.sourceCoordinator')}
                </span>
                {due && (
                    <span className="text-3xs" style={{ color: due.state === 'overdue' ? 'var(--status-error)' : undefined }}>
                        {due.state === 'overdue'
                            ? t(due.autoApply ? 'needsYou.dueOverdueAuto' : 'needsYou.dueOverdue', { span: formatSpan(due.ms) })
                            : t(due.autoApply ? 'needsYou.dueInAuto' : 'needsYou.dueIn', { span: formatSpan(due.ms) })}
                    </span>
                )}
            </div>
            <ProjectMissionLine meshId={decision.meshId} missionTitle={decision.missionTitle} carryOver={decision.carryOver} projectName={projectName} onOpenMission={onOpenMission} />
            <div className="text-sm font-semibold text-text-primary">{shown.question}</div>
            {shown.context && <div className="text-xs text-text-secondary whitespace-pre-wrap">{shown.context}</div>}

            {shown.options.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('needsYou.optionsLabel')}>
                    {shown.options.map(o => {
                        const isRec = o.id === decision.recommended
                        const isPicked = picked === o.id
                        return (
                            <Button
                                key={o.id}
                                size="sm"
                                variant={isRec ? 'primary' : 'secondary'}
                                disabled={busy}
                                aria-pressed={preselect !== undefined ? isPicked : undefined}
                                className={cn('min-h-[44px] md:min-h-0 whitespace-normal text-left max-w-full', isPicked && 'ring-2 ring-accent-primary')}
                                title={o.detail}
                                onClick={() => choose(o.id)}
                            >
                                {o.label}{isRec ? ` · ${t('needsYou.recommended')}` : ''}
                            </Button>
                        )
                    })}
                </div>
            )}
            {pickedOption && (
                <div className="flex items-center gap-2">
                    <Button size="sm" className="min-h-[44px] md:min-h-0" variant="primary" disabled={busy} onClick={() => onAnswer({ optionId: pickedOption.id })}>
                        {t('needsYou.confirmChoice', { label: pickedOption.label })}
                    </Button>
                    <Button size="sm" className="min-h-[44px] md:min-h-0" variant="ghost" disabled={busy} onClick={() => setPicked(undefined)}>{t('needsYou.cancel')}</Button>
                </div>
            )}
            {decision.allowFreeText && !confirmation && (
                <div className="flex gap-2">
                    <input
                        className="input flex-1 min-w-0 text-xs min-h-[44px] md:min-h-0"
                        value={text}
                        placeholder={t('needsYou.freeTextPlaceholder')}
                        aria-label={t('needsYou.freeTextPlaceholder')}
                        disabled={busy}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') sendText() }}
                        // On-screen keyboard: once it has animated in, bring the field back into view (the
                        // bottom sheet also shrinks to the visual viewport, see TodoDrawer).
                        onFocus={e => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 300) }}
                    />
                    <Button size="sm" className="min-h-[44px] md:min-h-0" disabled={busy || !text.trim()} onClick={sendText}>{t('needsYou.send')}</Button>
                </div>
            )}
            {onLater && (
                <div className="flex justify-end">
                    <button type="button" className="min-h-[44px] md:min-h-0 px-2 text-3xs text-text-muted hover:text-text-primary underline decoration-dotted" onClick={onLater}>{t('needsYou.later')}</button>
                </div>
            )}
            {outcome && !outcome.ok && <div className="text-2xs" style={{ color: 'var(--status-error)' }} role="alert">{t('needsYou.answerFailed', { code: outcome.code ?? '' })}</div>}
        </div>
    )
}

/** A recorded answer: what was recorded, who/how, delivery state, Undo and Change (design §6.4). */
export function AnsweredCard({ item, busy, nowMs, projectName, onUndo, onChange }: {
    item: NeedsYouAnswered
    busy?: boolean
    nowMs: number
    projectName?: string
    onUndo: () => void
    onChange: (input: { optionId?: string; text?: string }) => void
}) {
    const { t } = useTranslation('common')
    const [changing, setChanging] = useState(false)
    const [text, setText] = useState('')
    const confirm = isCloseConfirmation({ question: item.question, source: 'coordinator', options: item.options })
    const shown = localizeConfirmation(t, item, confirm)
    const summary = describeAnswer(item.answer, shown.options) || '—'
    const inProgress = mayAlreadyBeInProgress(item.answer.at, nowMs)
    return (
        <div data-testid="needs-you-answered-card" data-decision-id={item.itemId} className="rounded-lg border border-border-subtle p-3 flex flex-col gap-1.5 bg-bg-panel">
            <div className="text-xs text-text-secondary">{shown.question}</div>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-text-primary">{t('needsYou.answeredWith', { answer: summary })}</span>
                {item.autoApplied && <span className="text-3xs rounded px-1.5 py-0.5 bg-bg-secondary text-text-muted">{t('needsYou.autoApplied')}</span>}
                {item.deliveryState && <span className="text-3xs text-text-muted" data-testid="needs-you-delivery">{t(`needsYou.delivery.${item.deliveryState}`)}</span>}
                <Button size="sm" variant="ghost" disabled={busy} onClick={onUndo}>{t('needsYou.undo')}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(v => !v)}>{t('needsYou.change')}</Button>
            </div>
            {inProgress && <div className="text-2xs text-text-muted" data-testid="needs-you-in-progress">{t('needsYou.mayBeInProgress')}</div>}
            {changing && (
                <div className="flex flex-wrap gap-2 items-center">
                    {shown.options.map(o => (
                        <Button key={o.id} size="sm" disabled={busy} onClick={() => { setChanging(false); onChange({ optionId: o.id }) }}>{o.label}</Button>
                    ))}
                    {item.allowFreeText && (
                        <>
                            <input className="input flex-1 min-w-0 text-xs" value={text} aria-label={t('needsYou.freeTextPlaceholder')} placeholder={t('needsYou.freeTextPlaceholder')} onChange={e => setText(e.target.value)} />
                            <Button size="sm" disabled={busy || !text.trim()} onClick={() => { const v = text.trim(); setText(''); setChanging(false); onChange({ text: v }) }}>{t('needsYou.send')}</Button>
                        </>
                    )}
                </div>
            )}
            <div className="text-3xs text-text-muted">{projectName ?? getMeshName(item.meshId) ?? item.meshId.slice(0, 8)}</div>
        </div>
    )
}
