import { unwrapStagedAnswer } from './assistant-staged'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>
type Choice = { meshId: string; targetSessionId: string; action: 'approve' | 'reject'; button: string; modalIdentity: string; label: string; message: string }
type ExecutionView = { executionEnabled: boolean; executionAvailable: boolean; restriction: string; choices: Choice[]; limitations: string }

/** Uses the authenticated dashboard transport. The daemon rechecks the selected modal before issuing consent. */
export default function AssistantExecutionControls({ daemonId, sessionId, status, sendCommand }: {
    daemonId?: string | null; sessionId?: string; status?: string; sendCommand: SendCommand
}) {
    const { t } = useTranslation('common')
    const [view, setView] = useState<ExecutionView | null>(null)
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState('')
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const sequence = useRef(0)
    const refresh = async () => {
        const seq = ++sequence.current
        if (!daemonId || !sessionId) return
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_execution_state', { assistantSessionId: sessionId }))
            if (seq !== sequence.current) return
            setView(out?.success && Array.isArray(out.choices) ? out as ExecutionView : null)
            setSelected('')
        } catch { if (seq === sequence.current) setView(null) }
    }
    useEffect(() => { setView(null); setNotice(''); void refresh(); return () => { ++sequence.current } }, [daemonId, sessionId, status])
    const toggle = async () => {
        if (!daemonId || !view || busy) return
        setBusy(true)
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_execution_settings', { enabled: !view.executionEnabled }))
            setNotice(out?.success ? '' : String(out?.code || out?.error || t('assistantExecution.ownerAuthenticationRequired')))
            await refresh()
        } catch (error) { setNotice(String(error)) } finally { setBusy(false) }
    }
    const direct = async () => {
        const choice = view?.choices[Number(selected)]
        if (!choice || !daemonId || !sessionId || !view?.executionAvailable || busy || selected === '') return
        setBusy(true)
        try {
            const { meshId, targetSessionId, action, button } = choice
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'send_chat', { targetSessionId: sessionId,
                message: `${action === 'approve' ? 'Approve' : 'Reject'} the selected permission for ${choice.label}.`,
                assistantOwnerAction: { meshId, targetSessionId, action, button }, expectedOwnerModalIdentity: choice.modalIdentity }))
            setNotice(out?.success && out.ownerActionExpiresAt
                ? t('assistantExecution.directionSent', { expiresAt: new Date(out.ownerActionExpiresAt).toLocaleTimeString() })
                : String(out?.code || out?.error || t('assistantExecution.directionUnauthorized')))
            await refresh()
        } catch (error) { setNotice(String(error)) } finally { setBusy(false) }
    }
    return <div className="relative text-xs">
        <button type="button" className="chat-activity-toggle" aria-expanded={open} onClick={() => { setOpen(!open); void refresh() }}>{t('assistantExecution.toggleLabel', { state: t(view ? view.executionEnabled ? 'assistantExecution.on' : 'assistantExecution.off' : 'assistantExecution.unavailable') })}</button>
        {open && <div role="dialog" aria-label={t('assistantExecution.controlsLabel')} className="absolute right-0 z-20 w-80 max-w-[90vw] rounded border border-border-default bg-bg-card p-3 shadow-xl space-y-2">
            <p>{view ? t('assistantExecution.restrictionSummary', { restriction: view.restriction, availability: t(view.executionAvailable ? 'assistantExecution.available' : 'assistantExecution.closed') }) : t('assistantExecution.stateUnavailable')}</p>
            <p>{view?.limitations || t('assistantExecution.limitations')}</p>
            <button type="button" disabled={!view || busy} onClick={() => void toggle()}>{t(view?.executionEnabled ? 'assistantExecution.turnOff' : 'assistantExecution.turnOn')}</button>
            <button type="button" disabled={busy} onClick={() => void refresh()}>{t('assistantExecution.refreshPermissions')}</button>
            <label className="block">{t('assistantExecution.currentPermission')}
                <select aria-label={t('assistantExecution.currentPermission')} className="w-full bg-bg-card" value={selected} disabled={!view?.executionAvailable || busy} onChange={e => setSelected(e.target.value)}>
                    <option value="">{t('assistantExecution.selectTargetAndButton')}</option>
                    {view?.choices.map((c, i) => <option key={`${c.targetSessionId}:${c.button}:${c.modalIdentity}`} value={i}>{c.label}: {c.button} — {c.message}</option>)}
                </select>
            </label>
            <button type="button" disabled={!view?.executionAvailable || selected === '' || busy} onClick={() => void direct()}>{t('assistantExecution.sendDirection')}</button>
            <p>{t('assistantExecution.chatInstructions')}</p>
            {notice && <p role="status">{notice}</p>}
        </div>}
    </div>
}
