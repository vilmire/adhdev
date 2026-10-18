/**
 * "Following N" — the projects the assistant is following (its open relay
 * threads; 2026-10-18 review). The assistant starts following a project when it
 * sends it work, and relays its reports and progress / stall notices from then
 * on. The pill shows how many; the list says since when and lets the owner stop
 * following one (the next request to that project starts again).
 *
 * Hidden while the assistant follows nothing or the daemon has no list verb.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { RelativeTime } from '../ui/RelativeTime'
import { IconX } from '../Icons'
import { unwrapStagedAnswer } from './assistant-staged'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface WatchedThread {
    meshId: string
    project: string | null
    openedAt: number
    lastSendAt: number
}

export default function AssistantWatchedProjects({ daemonId, status, sendCommand }: {
    daemonId: string | null | undefined
    status?: string
    sendCommand: SendCommand
}) {
    const { t } = useTranslation('common')
    const [threads, setThreads] = useState<WatchedThread[]>([])
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const [ownerRequired, setOwnerRequired] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const seq = useRef(0)

    const refresh = useCallback(async () => {
        if (!daemonId) { setThreads([]); return }
        const mine = ++seq.current
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_threads', {}))
            if (mine !== seq.current) return
            setThreads(out?.success && Array.isArray(out.threads) ? out.threads as WatchedThread[] : [])
        } catch { if (mine === seq.current) setThreads([]) }
    }, [daemonId, sendCommand])

    useEffect(() => { void refresh() }, [refresh, status])

    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
    }, [open])

    if (threads.length === 0) return null

    const stop = async (meshId: string) => {
        if (!daemonId) return
        setBusy(meshId)
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_thread_close', { meshId }))
            // A password-less standalone dashboard is a local client; stopping is owner-only.
            setOwnerRequired(out?.code === 'COMMAND_SOURCE_REJECTED')
        } catch { /* the refresh shows the truth */ }
        setBusy(null)
        await refresh()
    }

    return (
        <div ref={rootRef} className="assistant-watched relative" data-assistant-watched-count={threads.length}>
            <button
                type="button"
                className={cn('chat-activity-toggle assistant-watched-badge', open && 'chat-activity-toggle-active')}
                onClick={() => { setOpen(v => { if (!v) void refresh(); return !v }) }}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={t('assistantWatched.hint')}
            >
                <span className="chat-activity-toggle-dot" />
                {t('assistantWatched.badge', { count: threads.length })}
            </button>
            {open && (
                <div
                    role="dialog"
                    aria-label={t('assistantWatched.title')}
                    className="assistant-staged-panel assistant-watched-panel pointer-events-auto absolute right-0 top-full mt-1.5 flex max-h-[min(60vh,420px)] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card text-xs text-text-secondary shadow-xl backdrop-blur-xl"
                >
                    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                        <span className="font-semibold text-text-primary">{t('assistantWatched.title')}</span>
                        <button type="button" className="btn btn-icon ml-auto" onClick={() => setOpen(false)} aria-label={t('assistantStaged.close')}>
                            <IconX size={14} />
                        </button>
                    </div>
                    <p className="m-0 px-3 pt-2 text-text-muted">{t('assistantWatched.hint')}</p>
                    {ownerRequired && <p className="m-0 px-3 pt-2 text-status-error">{t('assistantWatched.ownerRequired')}</p>}
                    <ul className="m-0 flex list-none flex-col gap-1 overflow-y-auto p-2">
                        {threads.map(thread => (
                            <li key={thread.meshId} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]">
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold text-text-primary">{thread.project ?? t('assistantWatched.removedProject')}</div>
                                    <div className="text-text-muted">{t('assistantWatched.lastRequest')} <RelativeTime value={thread.lastSendAt} /></div>
                                </div>
                                <button type="button" className="btn btn-quiet shrink-0" disabled={busy === thread.meshId} onClick={() => { void stop(thread.meshId) }}>
                                    {t('assistantWatched.stop')}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}
