/**
 * "Remembered recently" — the assistant pane's compact surface for what the
 * assistant saved to memory, with an undo link per write (design
 * docs/design/2026-11-01-assistant-memory.md §3.2).
 *
 * A small pill in the pane's top-right control bar, hidden while nothing
 * stands (or the daemon has no digest verb). Clicking it lists the last 24 h,
 * newest first: what changed, where (notebook / archive / project), who caused
 * it, and Undo. An archive move is one row with one undo. The pill carries only
 * a count; memory text appears inside the opened panel, never in a notification.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { RelativeTime } from '../ui/RelativeTime'
import { IconX } from '../Icons'
import {
    groupDigestRows,
    mergePayload,
    standingMemoryChanges,
    type AssistantMemoryDigestRow,
    type AssistantMemorySuggestion,
} from './assistant-memory-digest'
import { undoKey, useAssistantMemoryDigest, type AssistantMemoryDigestState } from '../../hooks/useAssistantMemoryDigest'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

const KNOWN_ORIGINS = new Set(['human', 'relay', 'review', 'review_tainted', 'owner', 'decision_promotion', 'curator'])
const KNOWN_ACTIONS = new Set(['add', 'replace', 'remove', 'archive'])

export interface AssistantMemoryDigestProps {
    daemonId: string | null | undefined
    status?: string
    sendCommand: SendCommand
}

export default function AssistantMemoryDigest({ daemonId, status, sendCommand }: AssistantMemoryDigestProps) {
    const state = useAssistantMemoryDigest({ daemonId, enabled: !!daemonId, status, sendCommand })
    return <AssistantMemoryDigestView state={state} />
}

export function AssistantMemoryDigestView({ state }: { state: AssistantMemoryDigestState }) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const standing = standingMemoryChanges(state.digest)
    const rows = useMemo(() => groupDigestRows(state.digest?.entries ?? []), [state.digest])
    const suggestions = state.digest?.suggestions ?? []

    useEffect(() => {
        if (standing === 0 && rows.length === 0 && suggestions.length === 0) setOpen(false)
    }, [standing, rows.length, suggestions.length])

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

    if (!state.digest || (standing === 0 && rows.length === 0 && suggestions.length === 0)) return null

    const toggle = () => {
        setOpen(v => {
            if (!v) void state.refresh()
            return !v
        })
    }
    const c = state.digest.counts

    return (
        <div ref={rootRef} className="assistant-memory-digest relative flex items-center gap-1.5" data-assistant-memory-digest-count={standing}>
            <button
                type="button"
                className={cn('chat-activity-toggle assistant-memory-digest-badge', open && 'chat-activity-toggle-active')}
                onClick={toggle}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={t('assistantMemoryDigest.badgeTitle')}
                aria-label={`${t('assistantMemoryDigest.badge', { count: standing })} — ${t('assistantMemoryDigest.badgeTitle')}`}
            >
                <span className="chat-activity-toggle-dot" />
                {t('assistantMemoryDigest.badge', { count: standing })}
            </button>
            {open && (
                <div
                    role="dialog"
                    aria-label={t('assistantMemoryDigest.title')}
                    className="assistant-memory-digest-panel pointer-events-auto absolute right-0 top-full mt-1.5 flex max-h-[min(60vh,520px)] w-[min(420px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card text-xs text-text-secondary shadow-xl backdrop-blur-xl"
                >
                    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                        <span className="font-semibold text-text-primary">{t('assistantMemoryDigest.title')}</span>
                        <span className="text-text-muted">{t('assistantMemoryDigest.counts', { added: c.added, replaced: c.replaced, removed: c.removed, promoted: c.promoted })}</span>
                        <button type="button" className="btn-ghost ml-auto rounded p-1" onClick={() => setOpen(false)} aria-label={t('assistantMemoryDigest.close')}>
                            <IconX size={12} />
                        </button>
                    </div>
                    <div className="flex flex-col overflow-y-auto">
                        {rows.map(row => <DigestRow key={row.entries[0].id} row={row} state={state} />)}
                        {state.digest.truncated && <div className="px-3 py-2 text-text-muted">{t('assistantMemoryDigest.older')}</div>}
                        {suggestions.length > 0 && (
                            <div className="border-t border-border-subtle" data-memory-digest-suggestions>
                                <div className="px-3 py-2 font-semibold text-text-primary">{t('assistantMemoryDigest.suggestions.title')}</div>
                                {suggestions.map((sg, i) => <SuggestionRow key={`${sg.kind}:${i}:${sg.items.join('|')}`} sg={sg} state={state} />)}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

function DigestRow({ row, state }: { row: AssistantMemoryDigestRow; state: AssistantMemoryDigestState }) {
    const { t } = useTranslation('common')
    // The text shown is the entry itself: for a move, the archive line's text (same as the file line's).
    const main = row.entries[0]
    const target = row.batchId ? { batchId: row.batchId } : { id: main.id }
    const key = undoKey(target)
    const busy = state.busyKeys.has(key)
    const outcome = state.outcomes[key]
    const moved = !!row.batchId
    const undoable = row.entries.some(e => e.state === 'applied' && e.undoable)
    const action = moved ? t('assistantMemoryDigest.action.archive') : KNOWN_ACTIONS.has(main.action) ? t(`assistantMemoryDigest.action.${main.action}`) : main.action
    const origin = KNOWN_ORIGINS.has(main.origin) ? t(`assistantMemoryDigest.origin.${main.origin}`) : main.origin
    const where = main.tier === 'core' ? t('assistantMemoryDigest.tier.core') : main.scope === 'project' ? t('assistantMemoryDigest.tier.project') : t('assistantMemoryDigest.tier.archive')
    const done = row.entries.every(e => e.state === 'undone' || e.state === 'reverted')
    return (
        <div className="flex flex-col gap-1 border-b border-border-subtle px-3 py-2 last:border-b-0" data-memory-digest-item={main.id} data-memory-digest-state={main.state}>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-text-primary">{action}</span>
                <span className="rounded bg-accent-primary/15 px-1.5 py-px text-[10px] leading-none font-bold uppercase tracking-wide text-accent-primary">
                    {main.target === 'user' ? t('assistantMemoryDigest.target.user') : t('assistantMemoryDigest.target.memory')}
                </span>
                <span className="text-text-muted">{where}</span>
                {main.promoted && <span className="text-text-muted" data-memory-digest-promoted>· {t('assistantMemoryDigest.promoted')}</span>}
                {main.state === 'staged' && <span className="text-text-muted">· {t('assistantMemoryDigest.staged')}</span>}
                {done && <span className="text-text-muted">· {t('assistantMemoryDigest.undone')}</span>}
            </div>
            <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg-secondary px-2 py-1 font-mono text-[11px] leading-snug text-text-primary">{main.text}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-text-muted">
                <span>{origin}</span>
                <span>·</span>
                <RelativeTime value={main.ts} live={false} />
                {undoable && (
                    <button
                        type="button"
                        className="btn btn-sm btn-secondary ml-auto"
                        disabled={busy}
                        data-memory-digest-action="undo"
                        onClick={() => void state.undo(target)}
                    >
                        {moved ? t('assistantMemoryDigest.undoMove') : t('assistantMemoryDigest.undo')}
                    </button>
                )}
            </div>
            {outcome && !outcome.ok && (
                <div className="text-status-error" data-memory-digest-error={outcome.code || ''}>
                    {t('assistantMemoryDigest.failed', { code: outcome.code || 'failed' })}
                </div>
            )}
        </div>
    )
}

/** A duplicate / similar pair or a long-unused entry the daemon will not change by itself. */
function SuggestionRow({ sg, state }: { sg: AssistantMemorySuggestion; state: AssistantMemoryDigestState }) {
    const { t } = useTranslation('common')
    const key = `merge:${sg.items.join('|')}`
    const outcome = state.outcomes[key]
    const canMerge = !!mergePayload(sg)
    return (
        <div className="flex flex-col gap-1 border-b border-border-subtle px-3 py-2 last:border-b-0" data-memory-digest-suggestion={sg.kind}>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-text-primary">{t(`assistantMemoryDigest.suggestions.${sg.kind}`)}</span>
                <span className="text-text-muted">{sg.target === 'user' ? t('assistantMemoryDigest.target.user') : t('assistantMemoryDigest.target.memory')}</span>
            </div>
            {sg.items.map((text, i) => (
                <div key={i} className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg-secondary px-2 py-1 font-mono text-[11px] leading-snug text-text-primary">{text}</div>
            ))}
            {canMerge && (
                <div className="flex">
                    <button
                        type="button"
                        className="btn btn-sm btn-secondary ml-auto"
                        disabled={state.busyKeys.has(key)}
                        data-memory-digest-action="merge"
                        onClick={() => void state.merge(sg)}
                    >
                        {t('assistantMemoryDigest.suggestions.mergeKeepFirst')}
                    </button>
                </div>
            )}
            {outcome && !outcome.ok && (
                <div className="text-status-error" data-memory-digest-error={outcome.code || ''}>
                    {t('assistantMemoryDigest.failed', { code: outcome.code || 'failed' })}
                </div>
            )}
        </div>
    )
}
