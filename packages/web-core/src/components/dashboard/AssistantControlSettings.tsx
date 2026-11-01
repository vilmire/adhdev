/**
 * Assistant pane: "CLI & quota" — switch the assistant to another CLI and choose
 * what happens when a provider's quota runs out (design 2026-11-01 §6.3, §8;
 * owner decisions H3 / H5). The daemon owns both: `assistant_switch_provider`
 * (waits for the end of the current reply) and `assistant_quota_failover`
 * (default "ask me"; automatic switching is opt-in and rate-limited).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>
export const ASSISTANT_QUOTA_FAILOVER_COMMAND = 'assistant_quota_failover' as const
export const ASSISTANT_SWITCH_PROVIDER_COMMAND = 'assistant_switch_provider' as const
export type QuotaFailoverMode = 'notify' | 'auto' | 'off'
const MODES: readonly QuotaFailoverMode[] = ['notify', 'auto', 'off']

function unwrap(raw: any): Record<string, any> | null {
    const r = raw && typeof raw === 'object' ? raw : null
    const inner = r?.result && typeof r.result === 'object' ? r.result : null
    return inner && ('assistant' in inner || 'success' in inner) ? inner : r
}

export function parseFailoverModes(raw: unknown): { assistant: QuotaFailoverMode; coordinator: QuotaFailoverMode } | null {
    const r = unwrap(raw)
    if (!r || r.success === false) return null
    const pick = (v: unknown): QuotaFailoverMode => (MODES as readonly string[]).includes(String(v)) ? v as QuotaFailoverMode : 'notify'
    return { assistant: pick(r.assistant), coordinator: pick(r.coordinator) }
}

export default function AssistantControlSettings({ daemonId, sendCommand }: { daemonId: string | null | undefined; sendCommand: SendCommand }) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    const [modes, setModes] = useState<{ assistant: QuotaFailoverMode; coordinator: QuotaFailoverMode } | null>(null)
    const [provider, setProvider] = useState('')
    const [note, setNote] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand

    const load = useCallback(async () => {
        if (!daemonId) return
        try { setModes(parseFailoverModes(await sendRef.current(daemonId, ASSISTANT_QUOTA_FAILOVER_COMMAND, { action: 'get' }))) } catch { setModes(null) }
    }, [daemonId])
    useEffect(() => { if (open) void load() }, [open, load])
    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
        window.addEventListener('pointerdown', onDown)
        return () => window.removeEventListener('pointerdown', onDown)
    }, [open])

    if (!daemonId) return null
    const setMode = async (role: 'assistant' | 'coordinator', mode: QuotaFailoverMode) => {
        setBusy(true); setNote(null)
        try { setModes(parseFailoverModes(await sendRef.current(daemonId, ASSISTANT_QUOTA_FAILOVER_COMMAND, { action: 'set', [role]: mode }))) }
        catch (e: any) { setNote(t('assistantControl.failed', { code: e?.message || 'failed' })) }
        finally { setBusy(false) }
    }
    const doSwitch = async () => {
        if (!provider.trim()) return
        setBusy(true); setNote(null)
        try {
            const r = unwrap(await sendRef.current(daemonId, ASSISTANT_SWITCH_PROVIDER_COMMAND, { provider: provider.trim() }))
            if (!r || r.success === false) setNote(t('assistantControl.failed', { code: String(r?.code || 'failed') }))
            else setNote(r.result === 'queued' ? t('assistantControl.switchQueued') : t('assistantControl.switchDone'))
        } catch (e: any) { setNote(t('assistantControl.failed', { code: e?.message || 'failed' })) }
        finally { setBusy(false) }
    }
    const roleRow = (role: 'assistant' | 'coordinator') => (
        <label className="flex items-center gap-2" key={role}>
            <span className="w-24 text-text-muted">{t(role === 'assistant' ? 'assistantControl.roleAssistant' : 'assistantControl.roleCoordinator')}</span>
            <select className="rounded border border-border-subtle bg-bg-secondary px-2 py-1 text-text-primary" disabled={busy || !modes} value={modes?.[role] ?? 'notify'}
                onChange={e => void setMode(role, e.target.value as QuotaFailoverMode)} data-failover-role={role}>
                {MODES.map(m => <option key={m} value={m}>{t(`assistantControl.failover${m === 'notify' ? 'Notify' : m === 'auto' ? 'Auto' : 'Off'}`)}</option>)}
            </select>
        </label>
    )
    return (
        <div ref={rootRef} className="assistant-control-settings relative flex items-center">
            {/* Icon-only: a rarely used setting must not crowd the assistant's control row on a phone. */}
            <button type="button" className={cn('chat-activity-toggle', open && 'chat-activity-toggle-active')} onClick={() => setOpen(v => !v)}
                aria-expanded={open} aria-haspopup="dialog" aria-label={t('assistantControl.open')} title={t('assistantControl.open')} data-assistant-control-open>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                    <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                </svg>
            </button>
            {open && (
                <div role="dialog" aria-label={t('assistantControl.title')}
                    className="pointer-events-auto absolute right-0 top-full z-10 mt-1.5 flex w-[min(360px,calc(100vw-24px))] flex-col gap-3 rounded-lg border border-border-default bg-bg-card p-3 text-xs text-text-secondary shadow-xl">
                    <div className="font-semibold text-text-primary">{t('assistantControl.title')}</div>
                    <div className="flex flex-col gap-1.5">
                        <span>{t('assistantControl.switchLabel')}</span>
                        <div className="flex gap-1.5">
                            <input className="min-w-0 flex-1 rounded border border-border-subtle bg-bg-secondary px-2 py-1 text-text-primary" value={provider}
                                placeholder={t('assistantControl.providerPlaceholder')} onChange={e => setProvider(e.target.value)} data-assistant-switch-provider />
                            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !provider.trim()} onClick={() => void doSwitch()} data-assistant-switch-action>
                                {t('assistantControl.switchAction')}
                            </button>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span>{t('assistantControl.failover')}</span>
                        {roleRow('assistant')}
                        {roleRow('coordinator')}
                        <span className="text-text-muted">{t('assistantControl.autoNote')}</span>
                    </div>
                    {note && <div data-assistant-control-note>{note}</div>}
                </div>
            )}
        </div>
    )
}
