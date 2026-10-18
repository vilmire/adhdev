import { unwrapStagedAnswer } from './assistant-staged'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isActionableProviderApproval } from '@adhdev/mesh-shared'
import { useDaemons } from '../../compat'
import { approvalButtonTone } from './ApprovalBanner'
import { IconX } from '../Icons'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>
type Choice = { meshId: string; targetSessionId: string; action: 'approve' | 'reject'; button: string; modalIdentity: string; label: string; message: string
    /** Authoritative provider episode from the daemon (absent from older daemons / legacy adapters). */
    modalKey?: string; attemptId?: string | null; generation?: number | null }
type ExecutionView = { executionEnabled: boolean; executionAvailable: boolean; choices: Choice[]; restriction?: string }
const choiceKey = (choice: Choice) => JSON.stringify([choice.meshId, choice.targetSessionId, choice.modalIdentity, choice.action, choice.button])

/** Owner consent still travels through assistant chat; it is not a direct provider resolve. */
export default function AssistantExecutionControls({ daemonId, sessionId, status, sendCommand }: {
    daemonId?: string | null; sessionId?: string; status?: string; sendCommand: SendCommand
}) {
    const { t } = useTranslation('common')
    const { ides, connectionStates } = useDaemons()
    const [snapshot, setSnapshot] = useState<{ scope: string; view: ExecutionView } | null>(null)
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState('')
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const [dismissed, setDismissed] = useState<string[]>([])
    const sequence = useRef(0)
    const actionSequence = useRef(0)
    const scope = JSON.stringify([daemonId, sessionId, status])
    const currentScope = useRef(scope)
    currentScope.current = scope
    const view = snapshot?.scope === scope ? snapshot.view : null
    const refresh = async () => {
        const seq = ++sequence.current
        const requestScope = scope
        setSelected('')
        setSnapshot(null)
        if (!daemonId || !sessionId) return
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_execution_state', { assistantSessionId: sessionId }))
            if (seq !== sequence.current || currentScope.current !== requestScope) return
            setSnapshot(out?.success && Array.isArray(out.choices) ? { scope: requestScope, view: out as ExecutionView } : null)
        } catch { if (seq === sequence.current && currentScope.current === requestScope) setSnapshot(null) }
    }
    useEffect(() => {
        ++actionSequence.current
        setNotice(''); setBusy(false); void refresh()
        return () => { ++sequence.current; ++actionSequence.current }
    }, [daemonId, sessionId, status])
    useEffect(() => { setDismissed([]) }, [daemonId, sessionId])

    // Older daemons' execution-state answers carry no provider lifecycle or
    // generation; newer ones state the exact episode per choice, which must match
    // the live roster. Only corroborated live local tool permissions appear here. Never infer trust
    // or permission from status, English prose, or an opaque modal hash alone.
    const requests = new Map<string, { key: string; title: string; machine: string; session: string; message: string; choices: Choice[] }>()
    for (const ide of ides) {
        const approval = ide.activeChat?.providerApproval
        const modal = ide.activeChat?.activeModal
        const owner = ide.ownerDaemonId || ide.daemonId
        if (owner !== daemonId || !ide.sessionId || ide.transport !== 'pty' || ide.activeInteractivePrompt
            || /^(stopped|exited|terminated|failed)$/.test(ide.status)
            || !['connected', 'ready'].includes(connectionStates[ide.machineId || owner || ''])
            || !/^(waiting|awaiting)_approval$/.test(ide.activeChat?.status || ide.status)
            || !isActionableProviderApproval(approval) || !approval || approval.resolvedAt != null || !modal
            || (approval.sessionId && approval.sessionId !== ide.sessionId)) continue
        const key = JSON.stringify([daemonId, sessionId, owner, ide.sessionId, approval.modalKey, approval.attemptId ?? null, approval.generation ?? null])
        if (dismissed.includes(key)) continue
        const choices = (view?.choices || []).filter(c => c && c.targetSessionId === ide.sessionId
            && typeof c.modalIdentity === 'string' && !!c.modalIdentity
            && typeof c.button === 'string' && !!c.button.trim()
            && ['approve', 'reject'].includes(c.action) && typeof c.meshId === 'string' && !!c.meshId
            && (!approval.meshId || approval.meshId === c.meshId)
            && approval.buttons.includes(c.button) && modal.buttons?.includes(c.button)
            && c.message === String(modal.message ?? '').slice(0, 500)
            // When the daemon states the episode identity it must be THIS episode.
            && (c.modalKey === undefined || (c.modalKey === approval.modalKey
                && (c.attemptId ?? null) === (approval.attemptId ?? null) && (c.generation ?? null) === (approval.generation ?? null))))
        if (!choices.length) continue
        const unique = [...new Map(choices.map(c => [choiceKey(c), c])).values()]
        const rank = (c: Choice) => ({ primary: 0, danger: 1, neutral: 2, always: 3 })[approvalButtonTone(c.button.toLowerCase())]
        unique.sort((a, b) => rank(a) - rank(b))
        requests.set(key, { key, title: ide.activeChat?.title || ide.sessionId || '', machine: ide.ownerMachineName || ide.hostname || owner || '', session: ide.sessionId || '', message: String(modal.message ?? ''), choices: unique })
    }
    const options = [...requests.values()].flatMap(request => request.choices.map(choice => ({ request, choice, key: JSON.stringify([request.key, choiceKey(choice)]) })))
    const selection = options.find(option => option.key === selected)
    const selectedKey = selection?.key
    // A removed/replaced request cannot regain a previous selection on a later snapshot.
    useEffect(() => { if (selected && !selectedKey) setSelected('') }, [selected, selectedKey])

    const toggle = async () => {
        if (!daemonId || !view || busy) return
        const requestScope = scope
        const seq = ++actionSequence.current
        setBusy(true)
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_execution_settings', { enabled: !view.executionEnabled }))
            if (currentScope.current !== requestScope || actionSequence.current !== seq) return
            setNotice(out?.success ? '' : t('assistantExecution.ownerAuthenticationRequired'))
            await refresh()
        } catch { if (currentScope.current === requestScope && actionSequence.current === seq) setNotice(t('assistantExecution.directionUnauthorized')) }
        finally { if (currentScope.current === requestScope && actionSequence.current === seq) setBusy(false) }
    }
    const direct = async () => {
        if (!selection || !daemonId || !sessionId || !view?.executionAvailable || busy) return
        const { choice, request } = selection
        const requestScope = scope
        const seq = ++actionSequence.current
        setBusy(true); setSelected('')
        try {
            const { meshId, targetSessionId, action, button } = choice
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'send_chat', { targetSessionId: sessionId,
                message: `${action === 'approve' ? 'Approve' : 'Reject'} the selected permission for ${choice.label}.`,
                assistantOwnerAction: { meshId, targetSessionId, action, button }, expectedOwnerModalIdentity: choice.modalIdentity,
                ...(choice.modalKey ? { expectedOwnerApprovalTarget: { modalKey: choice.modalKey, attemptId: choice.attemptId ?? null, generation: choice.generation ?? null } } : {}) }))
            if (currentScope.current !== requestScope || actionSequence.current !== seq) return
            const stale = out?.stalePrompt === true || out?.alreadyResolved === true
                || ['owner_modal_selection_changed', 'assistant_action_target_unavailable', 'consent_modal_changed'].includes(out?.code)
            if (stale) setDismissed(prev => [...prev, request.key])
            setNotice(stale ? t('assistantExecution.requestChanged') : out?.success && out.ownerActionExpiresAt
                ? t('assistantExecution.directionSent', { expiresAt: new Date(out.ownerActionExpiresAt).toLocaleTimeString() })
                : t('assistantExecution.directionUnauthorized'))
            await refresh()
        } catch { if (currentScope.current === requestScope && actionSequence.current === seq) setNotice(t('assistantExecution.directionUnauthorized')) }
        finally { if (currentScope.current === requestScope && actionSequence.current === seq) setBusy(false) }
    }
    // The switch (executionEnabled) and whether this assistant can act at all
    // (executionAvailable: only a verified, tool-restricted Claude Code
    // assistant) are different facts. "On" is shown only when both hold, so the
    // button never says on while the panel says it cannot act.
    const stateKey = !view ? 'assistantExecution.unavailable'
        : !view.executionEnabled ? 'assistantExecution.off'
        : view.executionAvailable ? 'assistantExecution.on' : 'assistantExecution.unsupported'
    const summaryKey = !view ? 'assistantExecution.stateUnavailable'
        : !view.executionEnabled ? 'assistantExecution.summaryOff'
        : view.executionAvailable ? 'assistantExecution.summaryOn' : 'assistantExecution.summaryUnsupported'
    // Hide the request form only once the daemon has said this assistant cannot
    // act; while an answer is loading it stays (disabled) so a refresh does not flicker.
    const cannotAct = !!view && !view.executionAvailable
    // This assistant's CLI can never answer permission requests (only a
    // tool-restricted Claude Code assistant can): the control would only ever
    // say "not supported", so it is not shown at all.
    if (view?.restriction === 'prompt_only') return null
    return <div className="assistant-execution-controls relative text-xs">
        <button type="button" className="chat-activity-toggle assistant-execution-toggle" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh() }}>{t('assistantExecution.toggleLabel', { state: t(stateKey) })}</button>
        {open && <div role="dialog" aria-label={t('assistantExecution.controlsLabel')} className="assistant-staged-panel assistant-execution-panel pointer-events-auto absolute right-0 top-full z-20 mt-1.5 flex max-h-[min(60vh,520px)] w-[min(400px,calc(100vw-24px))] flex-col overflow-y-auto rounded-lg border border-border-default bg-bg-card text-xs text-text-secondary shadow-xl backdrop-blur-xl">
            <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border-subtle bg-bg-card px-3 py-2">
                <span className="font-semibold text-text-primary">{t('assistantExecution.controlsLabel')}</span>
                <button type="button" className="btn btn-icon ml-auto" onClick={() => setOpen(false)} aria-label={t('assistantStaged.close')}><IconX size={14} /></button>
            </div>
            <div className="flex flex-col gap-3 p-3">
                <p className="m-0 leading-relaxed">{t(summaryKey)}</p>
                <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="btn btn-quiet assistant-panel-action" disabled={!view || busy} onClick={() => void toggle()}>{t(view?.executionEnabled ? 'assistantExecution.turnOff' : 'assistantExecution.turnOn')}</button>
                    {!cannotAct && <button type="button" className="btn btn-quiet assistant-panel-action" disabled={busy} onClick={() => void refresh()}>{t('assistantExecution.refreshPermissions')}</button>}
                </div>
                {!cannotAct && <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
                    <p className="m-0 font-semibold text-text-primary">{t('assistantExecution.currentPermission')}</p>
                    {requests.size === 0 && <p className="m-0 text-text-muted">{t('assistantExecution.noRequests')}</p>}
                    {[...requests.values()].map(request => <fieldset key={request.key} className="m-0 min-w-0 space-y-2 rounded-lg border border-border-subtle p-2.5" disabled={!view?.executionAvailable || busy}>
                        <legend className="px-1 font-semibold text-text-primary break-words">{request.title}</legend>
                        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-text-muted">
                            <dt>{t('assistantExecution.session')}</dt><dd className="m-0 break-all text-text-secondary">{request.session}</dd>
                            <dt>{t('assistantExecution.machine')}</dt><dd className="m-0 break-words text-text-secondary">{request.machine}</dd>
                            <dt>{t('assistantExecution.request')}</dt><dd className="m-0 whitespace-pre-wrap break-words text-text-secondary">{request.message || t('assistantExecution.noDescription')}</dd>
                        </dl>
                        <div role="group" aria-label={t('assistantExecution.selectTargetAndButton')} className="flex flex-col gap-2">
                            {options.filter(option => option.request.key === request.key).map(option => <label key={option.key} className="assistant-panel-choice">
                                <input type="radio" className="mt-0.5" name={`assistant-permission-${sessionId}`} value={option.key} checked={selected === option.key} onChange={() => setSelected(option.key)} />
                                <span className="min-w-0 break-words text-text-primary">{option.choice.button}</span>
                            </label>)}
                        </div>
                    </fieldset>)}
                    {selection && approvalButtonTone(selection.choice.button.toLowerCase()) === 'always' && <p className="m-0 text-status-warning">{t('approval.alwaysAllowWarning')}</p>}
                    {requests.size > 0 && <button type="button" className="btn btn-primary btn-sm self-start" disabled={!view?.executionAvailable || !selection || busy} onClick={() => void direct()}>{t('assistantExecution.sendDirection')}</button>}
                    {requests.size > 0 && <p className="m-0 text-2xs text-text-muted">{t('assistantExecution.chatInstructions')}</p>}
                </div>}
                {notice && <p role="status" className="m-0 text-text-muted">{notice}</p>}
            </div>
        </div>}
    </div>
}
