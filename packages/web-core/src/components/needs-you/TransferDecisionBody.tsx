/**
 * Owner approval of an agent-requested file transfer (file-transfer design 2026-11-02 section 6).
 * Shows the preview (counts, size, excluded, and the replaced file list for overwrites), and Approve sends the
 * ordinary owner `project_transfer_approve` to BOTH machines over the dashboard's own connection before the
 * decision itself is answered. The recorded answer alone approves nothing.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import Button from '../ui/Button'
import { call, formatBytes, type TransferView } from '../settings/projectTransferApi'
import type { NeedsYouDecision } from './needs-you-model'

export interface TransferDecisionBodyProps {
    decision: NeedsYouDecision
    busy?: boolean
    onAnswer: (input: { optionId?: string }) => void
}

export function TransferDecisionBody({ decision, busy, onAnswer }: TransferDecisionBodyProps) {
    const { t } = useTranslation('common')
    const transport = useTransport()
    const daemons = useBaseDaemons()
    const [tr, setTr] = useState<TransferView | null>(null)
    const [state, setState] = useState<'loading' | 'ready' | 'gone'>('loading')
    const [working, setWorking] = useState(false)
    const [err, setErr] = useState('')
    const approveOpt = decision.options.find(o => o.label.toLowerCase() === 'approve') ?? decision.options[0]
    const rejectOpt = decision.options.find(o => o.label.toLowerCase() === 'reject') ?? decision.options[1]
    const nameOf = useMemo(() => {
        const m = new Map<string, string>()
        for (const d of (daemons?.ides ?? []) as any[]) if (d?.type === 'adhdev-daemon' && typeof d.id === 'string') m.set(d.id, getMachineDisplayName(d, { fallbackId: d.id }))
        return (id: string) => m.get(id) ?? id.slice(-6)
    }, [daemons?.ides])

    useEffect(() => {
        let cancelled = false
        void call(transport.sendCommand, decision.daemonId, 'project_transfer_status', { transferId: decision.transferId }).then(body => {
            if (cancelled) return
            const x = body.success === true ? body.transfer as TransferView : null
            if (x && !['completed', 'failed', 'cancelled', 'expired', 'revoked'].includes(x.state)) { setTr(x); setState('ready') } else setState('gone')
        }).catch(() => { if (!cancelled) setState('gone') })
        return () => { cancelled = true }
    }, [transport.sendCommand, decision.daemonId, decision.transferId])

    const approve = async () => {
        if (!tr || !approveOpt) return
        setWorking(true); setErr('')
        try {
            for (const daemonId of [decision.daemonId, tr.peerDaemonId]) {
                const body = await call(transport.sendCommand, daemonId, 'project_transfer_approve', {
                    transferId: tr.id, selectionDigest: tr.selectionDigest, ...(tr.overwrite ? { replaceDigest: tr.overwrite.digest } : {}),
                })
                if (body.success !== true) throw new Error(typeof body.code === 'string' ? body.code : 'FAILED')
            }
            onAnswer({ optionId: approveOpt.id })
        } catch (e) { setErr(t('needsYou.transfer.failed', { code: e instanceof Error ? e.message : '' })) } finally { setWorking(false) }
    }
    const reject = async () => {
        if (!rejectOpt) return
        setWorking(true)
        if (tr) for (const daemonId of [decision.daemonId, tr.peerDaemonId]) await call(transport.sendCommand, daemonId, 'project_transfer_cancel', { transferId: tr.id }).catch(() => undefined)
        setWorking(false)
        onAnswer({ optionId: rejectOpt.id })
    }

    if (state === 'loading') return <div className="text-xs text-text-muted" data-testid="transfer-decision-loading">{t('needsYou.transfer.loading')}</div>
    if (state === 'gone' || !tr) return (
        <div className="flex flex-col gap-2" data-testid="transfer-decision-gone">
            <div className="text-xs text-text-muted">{t('needsYou.transfer.gone')}</div>
            {rejectOpt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer({ optionId: rejectOpt.id })}>{t('needsYou.transfer.reject')}</Button>}
        </div>
    )
    const ow = tr.overwrite
    return (
        <div className="flex flex-col gap-2" data-testid="transfer-decision-body">
            <div className="text-xs">{t('needsYou.transfer.summary', { files: tr.fileCount, size: formatBytes(tr.totalBytes), from: nameOf(decision.daemonId), to: nameOf(tr.peerDaemonId) })}</div>
            {tr.requestedBy && <div className="text-2xs text-text-muted" data-testid="transfer-decision-requested-by">{t(`settings.projectTransfer.agent.${tr.requestedBy.role}`)}</div>}
            {ow && ow.replacedCount > 0 ? (
                <details open data-testid="transfer-decision-replaced">
                    <summary className="text-xs cursor-pointer font-semibold">{t('needsYou.transfer.replacedTitle', { count: ow.replacedCount })}</summary>
                    <ul className="m-0 p-0 list-none max-h-32 overflow-auto text-2xs font-mono">
                        {ow.replaced.slice(0, 200).map(r => <li key={r.path}>{r.path} <span className="text-text-muted">{formatBytes(r.size)}</span></li>)}
                    </ul>
                    <div className="text-2xs text-text-muted">{t('settings.projectTransfer.overwrite.backupNote')}</div>
                </details>
            ) : ow ? <div className="text-2xs text-text-muted">{t('needsYou.transfer.newOnly', { count: ow.newCount })}</div> : null}
            {tr.excluded.length > 0 && <div className="text-2xs text-text-muted">{t('settings.projectTransfer.excludedTitle', { count: tr.excluded.length })}</div>}
            {working && <div className="text-2xs text-text-muted" role="status" data-testid="transfer-decision-progress">{t('needsYou.transfer.approving')}</div>}
            {err && <div className="text-2xs" style={{ color: 'var(--status-error)' }} role="alert">{err}</div>}
            <div className="flex gap-2">
                <Button size="sm" variant="primary" className="min-h-[44px] md:min-h-0" disabled={busy || working} onClick={() => { void approve() }} data-testid="transfer-decision-approve">{t('needsYou.transfer.approve')}</Button>
                <Button size="sm" variant="secondary" className="min-h-[44px] md:min-h-0" disabled={busy || working} onClick={() => { void reject() }} data-testid="transfer-decision-reject">{t('needsYou.transfer.reject')}</Button>
            </div>
        </div>
    )
}
