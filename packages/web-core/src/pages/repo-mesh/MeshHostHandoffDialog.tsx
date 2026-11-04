/**
 * "Move host" dialog (design 2026-11-01 §8): pick the machine that becomes the
 * mesh host, run the preflight checklist, start the handoff and watch the five
 * steps (freeze → transfer → verify → ACK → switch). Experimental: the daemon
 * refuses (and this dialog says so) unless `experimental.hostHandoff` is on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Dialog from '../../components/ui/Dialog'
import { AlertBanner } from '../../components/ui/AlertBanner'
import type { RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import {
    HANDOFF_STEPS, HOST_HANDOFF_COMMAND, canAbortHandoff, handoffAnswerFromError, canRetryHandoff, isHandoffTerminal, parseHandoffStatus, parsePreflight, parseStartResult, phaseToStep,
    unwrapHandoffAnswer, canaryProbeRefusal, canaryProbeSucceeded, isHandoffPending, needsTargetEnable, needsTargetPairing, type HandoffRecordView, type HandoffEvidenceView, type PreflightCheckView,
} from './host-handoff'

type SendCommand = (daemonId: string, command: string, payload?: any) => Promise<any>

interface Props {
    open: boolean
    onClose: () => void
    meshId: string
    hostDaemonId: string
    daemons: RepoMeshDaemonEntry[]
    projectNodes?: Array<{ id?: string; daemonId?: string; daemon_id?: string; machineLabel?: string; machine_label?: string; workspace?: string; nodeLabel?: string }>
    sendCommand: SendCommand
}

const POLL_MS = 2000

function label(d: RepoMeshDaemonEntry): string {
    return d.machineNickname || d.nickname || d.hostname || d.id
}

export function MeshHostHandoffDialog({ open, onClose, meshId, hostDaemonId, daemons, projectNodes = [], sendCommand }: Props) {
    const { t } = useTranslation('common')
    const [enabled, setEnabled] = useState<boolean | null>(null)
    const [target, setTarget] = useState('')
    const [targetNode, setTargetNode] = useState('')
    const [checks, setChecks] = useState<PreflightCheckView[] | null>(null)
    const [preflightOk, setPreflightOk] = useState(false)
    const [evidence, setEvidence] = useState<HandoffEvidenceView | undefined>()
    const [record, setRecord] = useState<HandoffRecordView | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Cloud P2P rejects `success:false`; a preflight refusal is an answer to show, not a transport failure.
    const answering: typeof sendCommand = (daemonId, command, payload) => sendCommand(daemonId, command, payload).catch((e: unknown) => {
        const answer = handoffAnswerFromError(e)
        if (answer) return answer
        throw e
    })
    const sendRef = useRef(answering)
    sendRef.current = answering
    // The journal lives on the machine that started the move. After the cutover the project's
    // host changes under this dialog, but progress and stop proof are still answered there.
    const sourceDaemon = useRef(hostDaemonId).current
    const machines = [...daemons]
    for (const node of projectNodes) {
        const id = node.daemonId || node.daemon_id
        if (id && !machines.some(d => daemonIdsEquivalent(d.id, id))) machines.push({ id, hostname: node.machineLabel || node.machine_label || id })
    }
    const candidates = machines.filter(d => !daemonIdsEquivalent(d.id, hostDaemonId))
    const targetNodes = projectNodes.filter(n => !!(n.daemonId || n.daemon_id) && daemonIdsEquivalent(n.daemonId || n.daemon_id!, target))
    const targetPayload = { targetDaemonId: target, ...(targetNode ? { targetNodeId: targetNode } : {}) }

    const call = useCallback(async (payload: Record<string, unknown>) => unwrapHandoffAnswer(await sendRef.current(sourceDaemon, HOST_HANDOFF_COMMAND, { meshId, ...payload })) ?? {}, [sourceDaemon, meshId])

    const refresh = useCallback(async () => {
        try {
            const status = parseHandoffStatus(await sendRef.current(sourceDaemon, HOST_HANDOFF_COMMAND, { op: 'status', meshId }))
            setEnabled(status.enabled)
            setRecord(status.source)
            setEvidence(status.evidence)
        } catch { setEnabled(false) }
    }, [sourceDaemon, meshId])

    useEffect(() => { if (open) { setError(null); void refresh() } }, [open, refresh])
    useEffect(() => {
        if (!open || !record || record.phase === 'aborted' || record.phase === 'committed' && evidence?.targetReady) return
        const timer = setInterval(() => { void refresh() }, POLL_MS)
        return () => clearInterval(timer)
    }, [open, record, evidence?.targetReady, refresh])

    /** The daemon answers `pending` while the work continues; repeating the call attaches to the same run. */
    const untilAnswered = useCallback(async (payload: Record<string, unknown>, onPending?: () => void) => {
        for (;;) {
            const raw = await sendRef.current(sourceDaemon, HOST_HANDOFF_COMMAND, { meshId, ...payload })
            if (!isHandoffPending(raw)) return raw
            onPending?.()
            await new Promise(resolve => setTimeout(resolve, POLL_MS))
        }
    }, [sourceDaemon, meshId])

    const runPreflight = async () => {
        if (!target) return
        setBusy(true); setError(null)
        try {
            const pf = parsePreflight(await untilAnswered({ op: 'preflight', ...targetPayload }))
            setChecks(pf.checks); setPreflightOk(pf.ok)
            if (pf.error) setError(pf.error)
        } catch (e: any) { setError(e?.message || 'failed') } finally { setBusy(false) }
    }
    const start = async () => {
        setBusy(true); setError(null)
        try {
            // The copy can take minutes. Progress and the abort button come from the journal meanwhile.
            const res = parseStartResult(await untilAnswered({ op: 'start', ...targetPayload }, () => { setBusy(false); void refresh() }))
            if (res.ok === false) { setError(res.code); return }
            await refresh()
        } catch (e: any) { setError(e?.message || 'failed') } finally { setBusy(false) }
    }
    const enableOn = async (daemonId: string) => {
        setBusy(true); setError(null)
        try {
            const res = unwrapHandoffAnswer(await sendRef.current(daemonId, HOST_HANDOFF_COMMAND, { op: 'set_enabled', enabled: true }))
            if (res?.enabled !== true) setError(String(res?.code || 'peer_capability_unconfirmed'))
            await refresh()
            setChecks(null); setPreflightOk(false)
        } catch (e: any) { setError(String(handoffAnswerFromError(e)?.code || e?.code || e?.message || 'failed')) } finally { setBusy(false) }
    }
    /** One-time code from the host, handed to the target by this owner connection. Neither is ever displayed. */
    const pairTarget = async () => {
        const node = targetNodes.find(n => n.id === targetNode) ?? (targetNodes.length === 1 ? targetNodes[0] : undefined)
        if (!node?.id || !node.workspace) { setError('host_key_unpinned'); return }
        setBusy(true); setError(null)
        try {
            const code = unwrapHandoffAnswer(await sendRef.current(sourceDaemon, 'create_mesh_host_pairing_token', { meshId }))
            if (typeof code?.token !== 'string') { setError(String(code?.code || 'host_key_unpinned')); return }
            const joined = unwrapHandoffAnswer(await sendRef.current(target, HOST_HANDOFF_COMMAND, { op: 'pair_host', meshId, token: code.token, hostDaemonId: sourceDaemon, targetNodeId: node.id, workspace: node.workspace }))
            if (joined?.success !== true) { setError(String(joined?.code || 'host_key_unpinned')); return }
            setChecks(null); setPreflightOk(false)
        } catch (e: any) { setError(e?.message || 'failed') } finally { setBusy(false) }
    }
    const act = async (op: 'abort' | 'retry') => {
        if (!record) return
        setBusy(true); setError(null)
        try {
            const res = await call({ op, handoffId: record.handoffId })
            if (res.success === false) setError(String(res.code || 'failed'))
            await refresh()
        } catch (e: any) { setError(e?.message || 'failed') } finally { setBusy(false) }
    }

    const active = !!record && !isHandoffTerminal(record.phase)
    const step = record ? phaseToStep(record.phase) : -1
    const uncertain = record?.phase === 'uncertain'

    return (
        <Dialog open={open} onClose={onClose} size="md" title={t('mesh.handoff.title')}
            footer={<button className="btn btn-secondary btn-sm" onClick={onClose}>{t('mesh.handoff.close')}</button>}>
            <div className="flex flex-col gap-3 text-sm text-text-secondary" data-host-handoff-dialog>
                {enabled === false && <AlertBanner variant="warning">
                    <span data-handoff-disabled>{t('mesh.handoff.disabled')}</span>
                    <button className="btn btn-secondary btn-sm ml-2" disabled={busy} onClick={() => void enableOn(sourceDaemon)} data-handoff-action="enable-source">{t('mesh.handoff.enable')}</button>
                </AlertBanner>}
                {enabled && !active && (
                    <>
                        <AlertBanner variant="info">{t('mesh.handoff.explain')}</AlertBanner>
                        <label className="flex flex-col gap-1">
                            <span className="text-xs text-text-muted">{t('mesh.handoff.target')}</span>
                            <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-sm text-text-primary" value={target}
                                disabled={busy} onChange={e => {
                                    const selected = e.target.value
                                    setTarget(selected); setChecks(null); setPreflightOk(false)
                                    const nodes = projectNodes.filter(n => !!(n.daemonId || n.daemon_id) && daemonIdsEquivalent(n.daemonId || n.daemon_id!, selected))
                                    setTargetNode(nodes.length === 1 ? nodes[0]?.id || '' : '')
                                }} data-handoff-target>
                                <option value="">{t('mesh.handoff.pickTarget')}</option>
                                {candidates.map(d => <option key={d.id} value={d.id}>{label(d)}</option>)}
                            </select>
                        </label>
                        {targetNodes.length > 1 && <select className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle" value={targetNode} disabled={busy}
                            onChange={e => { setTargetNode(e.target.value); setChecks(null); setPreflightOk(false) }} data-handoff-target-node aria-label={t('mesh.handoff.targetWorkspace')}>
                            <option value="">{t('mesh.handoff.pickWorkspace')}</option>
                            {targetNodes.map(n => <option key={n.id} value={n.id}>{n.nodeLabel || n.workspace || n.id}</option>)}
                        </select>}
                        <div className="flex gap-2">
                            <button className="btn btn-secondary btn-sm" disabled={!target || busy || (targetNodes.length > 1 && !targetNode)} onClick={() => void runPreflight()} data-handoff-action="preflight">{t('mesh.handoff.preflight')}</button>
                            <button className="btn btn-primary btn-sm" disabled={!preflightOk || busy} onClick={() => void start()} data-handoff-action="start">{t('mesh.handoff.start')}</button>
                        </div>
                        {checks && needsTargetEnable(checks) && (
                            <AlertBanner variant="warning">
                                <span>{t('mesh.handoff.targetDisabled')}</span>
                                <button className="btn btn-secondary btn-sm ml-2" disabled={busy} onClick={() => void enableOn(target)} data-handoff-action="enable-target">{t('mesh.handoff.enableTarget')}</button>
                            </AlertBanner>
                        )}
                        {checks && needsTargetPairing(checks) && (
                            <AlertBanner variant="warning">
                                <span>{t('mesh.handoff.pairExplain')}</span>
                                <button className="btn btn-secondary btn-sm ml-2" disabled={busy} onClick={() => void pairTarget()} data-handoff-action="pair-target">{t('mesh.handoff.pair')}</button>
                            </AlertBanner>
                        )}
                        {checks && canaryProbeRefusal(checks) && (
                            <AlertBanner variant="warning">
                                <span data-handoff-canary-unsupported>{t('mesh.handoff.canaryUnsupported')}</span>
                                <span className="block text-xs" data-handoff-canary-detail>{canaryProbeRefusal(checks)}</span>
                            </AlertBanner>
                        )}
                        {checks && canaryProbeSucceeded(checks) && (
                            <AlertBanner variant="info">
                                <span data-handoff-canary-host-bound>{t('mesh.handoff.canaryHostBound')}</span>
                            </AlertBanner>
                        )}
                        {checks && (
                            <ul className="flex flex-col gap-1" data-handoff-checks>
                                {checks.map(c => (
                                    <li key={c.id} className={c.ok ? 'text-status-online' : 'text-status-error'} data-handoff-check={c.id} data-ok={c.ok}>
                                        {c.ok ? '✓' : '✗'} {t(`mesh.handoff.check.${c.id}`, { defaultValue: c.id })}
                                        {!c.ok && c.code ? <span className="text-text-muted"> — {t(`mesh.handoff.code.${c.code}`, { defaultValue: c.code })}</span> : null}
                                        {c.id === 'fleet_members' && c.detail ? <span className="block text-xs text-text-muted" data-handoff-fleet-detail>{c.detail}</span> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
                {record && (
                    <div className="flex flex-col gap-2" data-handoff-phase={record.phase}>
                        <ol className="flex flex-wrap gap-2" data-handoff-steps>
                            {HANDOFF_STEPS.map((id, i) => (
                                <li key={id} data-handoff-step={id} data-state={i < step ? 'done' : i === step ? 'active' : 'todo'}
                                    className={i < step ? 'text-status-online' : i === step ? 'font-semibold text-text-primary' : 'text-text-muted'}>
                                    {i + 1}. {t(`mesh.handoff.step.${id}`)}
                                </li>
                            ))}
                        </ol>
                        {evidence && <dl className="text-xs" data-handoff-evidence>
                            <dt>{t('mesh.handoff.actualHost')}</dt><dd data-handoff-actual-host>{evidence.targetHost || t('mesh.handoff.notVerified')}</dd>
                            <dt>{t('mesh.handoff.actualSession')}</dt><dd data-handoff-actual-session>{evidence.targetVerified && evidence.targetSession || t('mesh.handoff.notVerified')}</dd>
                            <dt>{t('mesh.handoff.sourceStop')}</dt><dd data-handoff-source-stop>{evidence.sourceStopped ? evidence.sourceSessionIds.join(', ') || t('mesh.handoff.stopVerified') : t('mesh.handoff.notVerified')}</dd>
                        </dl>}
                        {record.phase === 'awaiting_ack'  && <div data-handoff-ack-waiting>{t('mesh.handoff.awaitingAck')}</div>}
                        {record.phase === 'committed' && <AlertBanner variant="success">{t('mesh.handoff.done')}</AlertBanner>}
                        {record.phase === 'aborted' && <AlertBanner variant="warning">{t('mesh.handoff.aborted', { reason: record.abortReason || '' })}</AlertBanner>}
                        {record.phase === 'aborted' && record.restore && <div className="text-xs" data-handoff-restore={record.restore.ok ? 'ok' : 'failed'}>{record.restore.ok ? t('mesh.handoff.restored') : t('mesh.handoff.restoreFailed', { reason: record.restore.error || '' })}</div>}
                        {uncertain && <AlertBanner variant="warning"><span data-handoff-uncertain>{t('mesh.handoff.uncertain')}</span></AlertBanner>}
                        {active && <div className="text-xs text-text-muted">{t('mesh.handoff.warning')}</div>}
                        {!isHandoffTerminal(record.phase) && (
                            <div className="flex gap-2">
                                {canRetryHandoff(record.phase) && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('retry')} data-handoff-action="retry">{t('mesh.handoff.retry')}</button>}
                                <button className="btn btn-secondary btn-sm" disabled={busy || !canAbortHandoff(record.phase)} onClick={() => void act('abort')} data-handoff-action="abort"
                                    title={canAbortHandoff(record.phase) ? undefined : t('mesh.handoff.abortDisabled')}>{t('mesh.handoff.abort')}</button>
                            </div>
                        )}
                    </div>
                )}
                {error && <div className="text-status-error" data-handoff-error={error}>{t(`mesh.handoff.code.${error}`, { defaultValue: error })}</div>}
            </div>
        </Dialog>
    )
}
