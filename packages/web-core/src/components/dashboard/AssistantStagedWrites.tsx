/**
 * "Held for your approval" — the assistant pane's compact surface for staged
 * memory / user / skill / project-note writes (design
 * 2026-10-07-assistant-layer.md §4.10.2, research 2026-10-08 Q8).
 *
 * A small "N pending" pill in the pane's top-right control bar, hidden while
 * nothing is held (or the daemon has no list verb). Clicking it opens a list:
 * each write shows its kind and target, the proposed text or a -/+ diff, where
 * it came from (relay / review / review after untrusted input) and when; a
 * review turn's writes are one card with "Approve all / Reject all" (resolved
 * together by `reviewTurnId`). A write the daemon refused on re-check stays in
 * the list with its code underneath.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { RelativeTime } from '../ui/RelativeTime'
import { IconX } from '../Icons'
import { groupStagedItems, type AssistantStagedGroup, type AssistantStagedItem } from './assistant-staged'
import { useAssistantStagedWrites, type AssistantStagedWritesState } from '../../hooks/useAssistantStagedWrites'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

const KNOWN_ORIGINS = new Set(['relay', 'review', 'review_tainted', 'human', 'owner'])
const KNOWN_ACTIONS = new Set(['add', 'replace', 'remove', 'create', 'patch', 'archive', 'record', 'forget'])

export interface AssistantStagedWritesProps {
    daemonId: string | null | undefined
    /** The assistant session's status — a busy → idle edge refreshes the list. */
    status?: string
    sendCommand: SendCommand
}

/** Container: owns the fetch/resolve state for the assistant pane. */
export default function AssistantStagedWrites({ daemonId, status, sendCommand }: AssistantStagedWritesProps) {
    const state = useAssistantStagedWrites({ daemonId, enabled: !!daemonId, status, sendCommand })
    return <AssistantStagedWritesView state={state} />
}

export function AssistantStagedWritesView({ state }: { state: AssistantStagedWritesState }) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const count = state.items?.length ?? 0
    const groups = useMemo(() => groupStagedItems(state.items || []), [state.items])

    useEffect(() => {
        if (count === 0) setOpen(false)
    }, [count])

    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('pointerdown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    if (count === 0) return null

    const toggle = () => {
        setOpen(v => {
            if (!v) void state.refresh()
            return !v
        })
    }

    return (
        <div ref={rootRef} className="assistant-staged relative" data-assistant-staged-count={count}>
            <button
                type="button"
                className={cn('chat-activity-toggle assistant-staged-badge', open && 'chat-activity-toggle-active')}
                onClick={toggle}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={t('assistantStaged.badgeTitle')}
            >
                <span className="chat-activity-toggle-dot" />
                {t('assistantStaged.badge', { count })}
            </button>
            {open && (
                <div
                    role="dialog"
                    aria-label={t('assistantStaged.title')}
                    className="assistant-staged-panel pointer-events-auto absolute right-0 top-full mt-1.5 flex max-h-[min(60vh,520px)] w-[min(420px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card text-xs text-text-secondary shadow-xl"
                >
                    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                        <span className="font-semibold text-text-primary">{t('assistantStaged.title')}</span>
                        <span className="text-text-muted">{t('assistantStaged.hint')}</span>
                        <button type="button" className="btn-ghost ml-auto rounded p-1" onClick={() => setOpen(false)} aria-label={t('assistantStaged.close')}>
                            <IconX size={12} />
                        </button>
                    </div>
                    <div className="flex flex-col gap-2 overflow-y-auto p-2">
                        {groups.map(group => (
                            <StagedGroupCard key={group.reviewTurnId || group.items[0].id} group={group} state={state} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

function StagedGroupCard({ group, state }: { group: AssistantStagedGroup; state: AssistantStagedWritesState }) {
    const { t } = useTranslation('common')
    const ids = group.items.map(i => i.id)
    const anyBusy = ids.some(id => state.busyIds.has(id))
    const failed = ids.filter(id => state.outcomes[id] && !state.outcomes[id].ok).length
    const batch = !!group.reviewTurnId && group.items.length > 1
    return (
        <div
            className="rounded-md border border-border-subtle bg-bg-secondary/40"
            data-staged-group={group.reviewTurnId || ''}
        >
            {group.reviewTurnId && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-2.5 py-1.5">
                    <span className="font-semibold text-text-primary">
                        {t('assistantStaged.reviewGroup', { count: group.items.length })}
                    </span>
                    {group.reviewAt && <RelativeTime value={group.reviewAt} live={false} className="text-text-muted" />}
                    {batch && (
                        <span className="ml-auto flex gap-1">
                            <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={anyBusy}
                                data-staged-action="apply-all"
                                onClick={() => void state.resolve({ reviewTurnId: group.reviewTurnId!, ids }, 'apply')}
                            >
                                {t('assistantStaged.approveAll')}
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={anyBusy}
                                data-staged-action="discard-all"
                                onClick={() => void state.resolve({ reviewTurnId: group.reviewTurnId!, ids }, 'discard')}
                            >
                                {t('assistantStaged.rejectAll')}
                            </button>
                        </span>
                    )}
                    {batch && failed > 0 && (
                        <div className="w-full text-status-error" data-staged-partial>
                            {t('assistantStaged.partial', { failed, total: group.items.length })}
                        </div>
                    )}
                </div>
            )}
            {group.items.map(item => <StagedItemRow key={item.id} item={item} state={state} />)}
        </div>
    )
}

function StagedItemRow({ item, state }: { item: AssistantStagedItem; state: AssistantStagedWritesState }) {
    const { t } = useTranslation('common')
    const busy = state.busyIds.has(item.id)
    const outcome = state.outcomes[item.id]
    const origin = KNOWN_ORIGINS.has(item.origin) ? t(`assistantStaged.origin.${item.origin}`) : item.origin
    const action = KNOWN_ACTIONS.has(item.action) ? t(`assistantStaged.action.${item.action}`) : item.action
    return (
        <div className="flex flex-col gap-1 px-2.5 py-2 [&+&]:border-t [&+&]:border-border-subtle" data-staged-item={item.id}>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-accent-primary/15 px-1.5 py-px text-[10px] leading-none font-bold uppercase tracking-wide text-accent-primary">
                    {t(`assistantStaged.kind.${item.kind}`)}
                </span>
                <span className="font-medium text-text-primary">{action}</span>
                {item.target && <span className="truncate font-mono text-text-primary" title={item.target}>{item.target}</span>}
                {item.detail && <span className="text-text-muted">· {item.detail}</span>}
            </div>
            <StagedBody item={item} />
            <div className="flex flex-wrap items-center gap-1.5 text-text-muted">
                <span data-staged-origin={item.origin}>{origin}</span>
                {item.reason === 'protected_skill' && <span>· {t('assistantStaged.protectedSkill')}</span>}
                {item.createdAt && <span>·</span>}
                {item.createdAt && <RelativeTime value={item.createdAt} live={false} />}
                <span className="ml-auto flex gap-1">
                    <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        data-staged-action="apply"
                        onClick={() => void state.resolve({ id: item.id }, 'apply')}
                    >
                        {t('assistantStaged.approve')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        disabled={busy}
                        data-staged-action="discard"
                        onClick={() => void state.resolve({ id: item.id }, 'discard')}
                    >
                        {t('assistantStaged.reject')}
                    </button>
                </span>
            </div>
            {outcome && !outcome.ok && (
                <div className="text-status-error" data-staged-error={outcome.code || ''}>
                    {t('assistantStaged.failed', { code: outcome.code || 'failed' })}
                </div>
            )}
        </div>
    )
}

function StagedBody({ item }: { item: AssistantStagedItem }) {
    const { t } = useTranslation('common')
    const pre = 'max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg-secondary px-2 py-1 font-mono text-[11px] leading-snug'
    if (item.diff) {
        return (
            <div className={pre}>
                {item.diff.before && <div className="text-status-error">{prefixLines('- ', item.diff.before)}</div>}
                {item.diff.after && <div className="text-status-online">{prefixLines('+ ', item.diff.after)}</div>}
            </div>
        )
    }
    if (item.text) return <div className={cn(pre, 'text-text-primary')}>{item.text}</div>
    if (item.action === 'archive') return null
    return <div className="italic text-text-muted">{t('assistantStaged.noText')}</div>
}

function prefixLines(prefix: string, text: string): string {
    return text.split('\n').map(line => prefix + line).join('\n')
}
