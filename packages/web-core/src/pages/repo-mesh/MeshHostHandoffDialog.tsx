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
    HANDOFF_STEPS, HOST_HANDOFF_COMMAND, canAbortHandoff, canRetryHandoff, isHandoffTerminal, parseHandoffStatus, parsePreflight, parseStartResult, phaseToStep,
    unwrapHandoffAnswer, canaryProbeRefusal, type HandoffRecordView, type HandoffEvidenceView, type PreflightCheckView,
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
    const sendRef = useRef(sendCommand)
    sendRef.current = sendCommand
    const machines = [...daemons]
    for (const node of projectNodes) {
        const id = node.daemonId || node.daemon_id
        if (id && !machines.some(d => daemonIdsEquivalent(d.id, id))) machines.push({ id, hostname: node.machineLabel || node.machine_label || id })
    }
    const candidates = machines.filter(d => !daemonIdsEquivalent(d.id, hostDaemonId))
    const targetNodes = projectNodes.filter(n => !!(n.daemonId || n.daemon_id) && daemonIdsEquivalent(n.daemonId || n.daemon_id!, target))
    const targetPayload = { targetDaemonId: target, ...(targetNode ? { targetNodeId: targetNode } : {}) }

    const call = useCallback(async (payload: Record<string, unknown>) => unwrapHandoffAnswer(await sendRef.current(hostDaemonId, HOST_HANDOFF_COMMAND, { meshId, ...payload })) ?? {}, [hostDaemonId, meshId])

    const refresh = useCallback(async () => {
        try {
            const status = parseHandoffStatus(await sendRef.current(hostDaemonId, HOST_HANDOFF_COMMAND, { op: 'status', meshId }))
            setEnabled(status.enabled)
            setRecord(status.source)
            setEvidence(status.evidence)
        } catch { setEnabled(false) }
    }, [hostDaemonId, meshId])

    useEffect(() => { if (open) { setError(null); void refresh() } }, [open, refresh])
    useEffect(() => {
        if (!open || !record || record.phase === 'aborted' || record.phase === 'committed' && evidence?.targetReady) return
        const timer = setInterval(() => { void refresh() }, POLL_MS)
        return () => clearInterval(timer)
    }, [open, record, evidence?.targetReady, refresh])

    const runPreflight = async () => {
        if (!target) return
        setBusy(true); setError(null)
        try {
            const pf = parsePreflight(await sendRef.current(hostDaemonId, HOST_HANDOFF_COMMAND, { op: 'preflight', meshId, ...targetPayload }))
            setChecks(pf.checks); setPreflightOk(pf.ok)
            if (pf.error) setError(pf.error)
        } catch (e: any) { setError(e?.message || 'failed') } finally { setBusy(false) }
    }
    const start = async () => {
        setBusy(true); setError(null)
        try {
            const res = parseStartResult(await sendRef.current(hostDaemonId, HOST_HANDOFF_COMMAND, { op: 'start', meshId, ...targetPayload }))
            if (res.ok === false) { setError(res.code); return }
            await refresh()
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
                {enabled === false && <AlertBanner variant="warning"><span data-handoff-disabled>{t('mesh.handoff.disabled')}</span></AlertBanner>}
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
                        {checks && canaryProbeRefusal(checks) && (
                            <AlertBanner variant="warning">
                                <span data-handoff-canary-unsupported>{t('mesh.handoff.canaryUnsupported')}</span>
                                <span className="block text-xs" data-handoff-canary-detail>{canaryProbeRefusal(checks)}</span>
                            </AlertBanner>
                        )}
                        {checks && (
                            <ul className="flex flex-col gap-1" data-handoff-checks>
                                {checks.map(c => (
                                    <li key={c.id} className={c.ok ? 'text-status-online' : 'text-status-error'} data-handoff-check={c.id} data-ok={c.ok}>
                                        {c.ok ? '✓' : '✗'} {t(`mesh.handoff.check.${c.id}`, { defaultValue: c.id })}
                                        {!c.ok && c.code ? <span className="text-text-muted"> — {t(`mesh.handoff.code.${c.code}`, { defaultValue: c.code })}</span> : null}
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
