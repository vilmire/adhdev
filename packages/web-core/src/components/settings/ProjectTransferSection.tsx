import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { AlertBanner } from '../ui/AlertBanner'
import Button from '../ui/Button'
import {
    TERMINAL_TRANSFER_STATES, call, formatBytes,
    type BrowseEntry, type SendCommand, type TransferView,
} from './projectTransferApi'

export interface ProjectTransferMachine {
    id: string
    name: string
    online: boolean
    workspaces: Array<{ id: string; path: string; label?: string }>
}

export interface ProjectTransferSectionProps {
    machines?: ProjectTransferMachine[]
    sendCommand?: SendCommand
    pollMs?: number
}

const errText = (body: Record<string, any>, fallback: string) =>
    typeof body.detail === 'string' && body.detail ? `${body.code ?? ''} ${body.detail}`.trim() : typeof body.code === 'string' ? body.code : fallback

export function ProjectTransferSection({ machines: machinesProp, sendCommand: sendProp, pollMs = 1500 }: ProjectTransferSectionProps = {}) {
    const { t } = useTranslation('common')
    const baseDaemons = useBaseDaemons()
    const transport = useTransport()
    const sendRef = useRef<SendCommand>(sendProp ?? transport.sendCommand)
    sendRef.current = sendProp ?? transport.sendCommand

    const machines = useMemo<ProjectTransferMachine[]>(() => {
        if (machinesProp) return machinesProp
        return (baseDaemons?.ides ?? [])
            .filter((d: any) => d?.type === 'adhdev-daemon' && typeof d?.id === 'string')
            .map((d: any) => ({
                id: d.id as string,
                name: getMachineDisplayName(d, { fallbackId: d.id }),
                online: (d.status ?? 'online') !== 'offline',
                workspaces: Array.isArray(d.workspaces) ? d.workspaces : [],
            }))
    }, [machinesProp, baseDaemons?.ides])
    const byId = useMemo(() => new Map(machines.map(m => [m.id, m])), [machines])

    const [fromId, setFromId] = useState('')
    const [fromWs, setFromWs] = useState('')
    const [toId, setToId] = useState('')
    const [toWs, setToWs] = useState('')
    const [folder, setFolder] = useState('')
    const [dir, setDir] = useState('')
    const [entries, setEntries] = useState<BrowseEntry[]>([])
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [preview, setPreview] = useState<TransferView | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [caps, setCaps] = useState<Record<string, { supported: boolean; reasons: string[] }>>({})
    const [transfers, setTransfers] = useState<TransferView[]>([])

    const fromMachine = byId.get(fromId)
    const toMachine = byId.get(toId)

    // Capabilities of the two chosen machines (helper present, direct link available).
    useEffect(() => {
        for (const id of [fromId, toId]) {
            if (!id || caps[id]) continue
            void call(sendRef.current, id, 'project_transfer_capabilities', {}).then(body => {
                setCaps(prev => ({ ...prev, [id]: { supported: body.supported === true, reasons: Array.isArray(body.reasons) ? body.reasons : [] } }))
            }).catch(() => setCaps(prev => ({ ...prev, [id]: { supported: false, reasons: ['UNREACHABLE'] } })))
        }
    }, [fromId, toId, caps])

    // Browse the source project.
    useEffect(() => {
        if (!fromId || !fromWs) { setEntries([]); return }
        let cancelled = false
        void call(sendRef.current, fromId, 'project_transfer_browse', { workspaceId: fromWs, path: dir }).then(body => {
            if (!cancelled) setEntries(body.success === true && Array.isArray(body.entries) ? body.entries : [])
        }).catch(() => { if (!cancelled) setEntries([]) })
        return () => { cancelled = true }
    }, [fromId, fromWs, dir])

    // Poll transfers on every machine that may hold a record.
    const refresh = useCallback(async () => {
        const ids = machines.filter(m => m.online).map(m => m.id)
        const all: TransferView[] = []
        await Promise.all(ids.map(async id => {
            try {
                const body = await call(sendRef.current, id, 'project_transfer_list', {})
                if (body.success === true && Array.isArray(body.transfers)) all.push(...(body.transfers as TransferView[]).map(x => ({ ...x, __machine: id } as TransferView)))
            } catch { /* machine unreachable */ }
        }))
        const merged = new Map<string, TransferView>()
        for (const x of all) { const cur = merged.get(x.id); if (!cur || x.role === 'source') merged.set(x.id, x) }
        setTransfers([...merged.values()].sort((a, b) => b.previewExpiresAt - a.previewExpiresAt))
    }, [machines])
    useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, pollMs)
        return () => clearInterval(timer)
    }, [refresh, pollMs])

    const toggle = (name: string) => {
        const rel = dir ? `${dir}/${name}` : name
        setSelected(prev => { const next = new Set(prev); if (next.has(rel)) next.delete(rel); else next.add(rel); return next })
    }

    const unsupportedMessage = [fromId, toId].map(id => {
        const c = caps[id]
        return c && !c.supported ? t('settings.projectTransfer.unsupported', { machine: byId.get(id)?.name ?? id, reason: c.reasons.join(', ') || '?' }) : ''
    }).find(Boolean) ?? ''

    const canPreview = !!(fromId && fromWs && toId && toWs && folder.trim() && selected.size > 0 && toId !== fromId && !unsupportedMessage && !busy)

    const handlePreview = async () => {
        setBusy(true); setError('')
        try {
            const body = await call(sendRef.current, fromId, 'project_transfer_create', {
                workspaceId: fromWs, selected: [...selected], targetDaemonId: toId, targetWorkspaceId: toWs, finalName: folder.trim(),
            })
            if (body.success === true && body.transfer) { setPreview(body.transfer as TransferView); void refresh() }
            else setError(`${t('settings.projectTransfer.createFailed')}: ${errText(body, '')}`)
        } catch (e) { setError(e instanceof Error ? e.message : t('settings.projectTransfer.createFailed')) }
        finally { setBusy(false) }
    }

    const approve = async (daemonId: string, tr: TransferView) => {
        const body = await call(sendRef.current, daemonId, 'project_transfer_approve', { transferId: tr.id, selectionDigest: tr.selectionDigest })
        if (body.success !== true) throw new Error(errText(body, t('settings.projectTransfer.actionFailed')))
    }
    const approveBoth = async () => {
        if (!preview) return
        setBusy(true); setError('')
        try {
            await approve(fromId, preview)
            await approve(toId, preview)
            setPreview(null); setSelected(new Set()); void refresh()
        } catch (e) { setError(e instanceof Error ? e.message : t('settings.projectTransfer.actionFailed')) }
        finally { setBusy(false) }
    }
    const cancelTransfer = async (tr: TransferView) => {
        const owner = (tr as any).__machine ?? (tr.role === 'source' ? fromId : toId)
        await call(sendRef.current, owner, 'project_transfer_cancel', { transferId: tr.id }).catch(() => undefined)
        if (preview?.id === tr.id) setPreview(null)
        void refresh()
    }

    const machineOptions = (value: string, onChange: (v: string) => void, testId: string) => (
        <select className="input" value={value} onChange={e => onChange(e.target.value)} data-testid={testId}>
            <option value="">—</option>
            {machines.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.name}</option>)}
        </select>
    )
    const wsOptions = (m: ProjectTransferMachine | undefined, value: string, onChange: (v: string) => void, testId: string) => (
        <select className="input" value={value} onChange={e => onChange(e.target.value)} disabled={!m} data-testid={testId}>
            <option value="">{t('settings.projectTransfer.chooseProject')}</option>
            {(m?.workspaces ?? []).map(w => <option key={w.id} value={w.id}>{w.label || w.path}</option>)}
        </select>
    )

    if (machines.length < 2) {
        return <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="project-transfer-no-machines">{t('settings.projectTransfer.noMachines')}</div>
    }

    return (
        <div className="flex flex-col gap-3" data-testid="project-transfer-section">
            <p className="text-xs text-text-muted m-0">{t('settings.projectTransfer.secretsNote')}</p>
            {(error || unsupportedMessage) && <AlertBanner variant={error ? 'error' : 'warning'}>{error || unsupportedMessage}</AlertBanner>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs">{t('settings.projectTransfer.fromMachine')}
                    {machineOptions(fromId, v => { setFromId(v); setFromWs(''); setDir(''); setSelected(new Set()) }, 'project-transfer-from-machine')}
                    {wsOptions(fromMachine, fromWs, v => { setFromWs(v); setDir(''); setSelected(new Set()) }, 'project-transfer-from-project')}
                </label>
                <label className="flex flex-col gap-1 text-xs">{t('settings.projectTransfer.toMachine')}
                    {machineOptions(toId, v => { setToId(v); setToWs('') }, 'project-transfer-to-machine')}
                    {wsOptions(toMachine, toWs, setToWs, 'project-transfer-to-project')}
                </label>
            </div>

            <label className="flex flex-col gap-1 text-xs">{t('settings.projectTransfer.newFolder')}
                <input className="input" value={folder} onChange={e => setFolder(e.target.value)} data-testid="project-transfer-folder" />
                <span className="text-text-muted">{t('settings.projectTransfer.newFolderHint')}</span>
            </label>

            {fromWs && (
                <div className="rounded-xl border border-border-subtle bg-bg-glass p-3" data-testid="project-transfer-browser">
                    <div className="text-xs font-medium mb-2">{t('settings.projectTransfer.selectItems')}</div>
                    <div className="text-2xs font-mono text-text-muted mb-2">
                        {dir ? <button type="button" className="underline" onClick={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')}>..</button> : t('settings.projectTransfer.root')}
                        {dir && <span> / {dir}</span>}
                    </div>
                    {entries.length === 0 && <div className="text-xs text-text-muted">{t('settings.projectTransfer.emptyDir')}</div>}
                    <ul className="m-0 p-0 list-none flex flex-col gap-1 max-h-64 overflow-auto">
                        {entries.map(e => {
                            const rel = dir ? `${dir}/${e.name}` : e.name
                            const blocked = !!e.excluded
                            return (
                                <li key={e.name} className="flex items-center gap-2 text-xs" data-testid={`project-transfer-entry-${e.name}`}>
                                    <input type="checkbox" disabled={blocked} checked={selected.has(rel)} onChange={() => toggle(e.name)} />
                                    {e.kind === 'dir'
                                        ? <button type="button" className="underline" onClick={() => setDir(rel)}>{e.name}/</button>
                                        : <span>{e.name}</span>}
                                    {e.size !== undefined && <span className="text-text-muted">{formatBytes(e.size)}</span>}
                                    {blocked && <span className="text-2xs text-text-muted border border-border-subtle rounded px-1">{t('settings.projectTransfer.excludedBadge')}</span>}
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}

            <div>
                <Button variant="primary" disabled={!canPreview} onClick={() => { void handlePreview() }} data-testid="project-transfer-preview">
                    {busy && !preview ? t('settings.projectTransfer.previewing') : t('settings.projectTransfer.preview')}
                </Button>
                {selected.size === 0 && <span className="ml-2 text-xs text-text-muted">{t('settings.projectTransfer.needSelection')}</span>}
            </div>

            {preview && (
                <div className="rounded-xl border border-border-subtle bg-bg-glass p-3 flex flex-col gap-2" data-testid="project-transfer-preview-panel">
                    <div className="text-sm font-medium">{t('settings.projectTransfer.previewTitle')}</div>
                    <div className="text-xs">{t('settings.projectTransfer.previewSummary', { files: preview.fileCount, size: formatBytes(preview.totalBytes) })}</div>
                    <div className="text-xs text-text-muted">{t('settings.projectTransfer.destination', { machine: toMachine?.name ?? toId, project: toMachine?.workspaces.find(w => w.id === toWs)?.label ?? toWs, folder: preview.finalName })}</div>
                    <ul className="m-0 p-0 list-none max-h-40 overflow-auto text-2xs font-mono">
                        {preview.entries.filter(e => e.kind === 'file').slice(0, 200).map(e => <li key={e.path}>{e.path} <span className="text-text-muted">{formatBytes(e.size ?? 0)}</span></li>)}
                    </ul>
                    {preview.excluded.length > 0 && (
                        <details data-testid="project-transfer-excluded">
                            <summary className="text-xs cursor-pointer">{t('settings.projectTransfer.excludedTitle', { count: preview.excluded.length })}</summary>
                            <ul className="m-0 p-0 list-none max-h-32 overflow-auto text-2xs font-mono text-text-muted">
                                {preview.excluded.slice(0, 200).map(x => <li key={x.path}>{x.path} — {x.reason}</li>)}
                            </ul>
                        </details>
                    )}
                    <div className="text-2xs text-text-muted">{t('settings.projectTransfer.previewExpires')}</div>
                    <div className="flex gap-2">
                        <Button variant="primary" disabled={busy} onClick={() => { void approveBoth() }} data-testid="project-transfer-approve-both">{t('settings.projectTransfer.approveBoth')}</Button>
                        <Button variant="ghost" onClick={() => { void cancelTransfer(preview) }}>{t('settings.projectTransfer.cancel')}</Button>
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-2" data-testid="project-transfer-list">
                <div className="text-sm font-medium">{t('settings.projectTransfer.listTitle')}</div>
                {transfers.length === 0 && <div className="text-xs text-text-muted">{t('settings.projectTransfer.noTransfers')}</div>}
                {transfers.map(tr => {
                    const done = TERMINAL_TRANSFER_STATES.has(tr.state)
                    const pct = tr.totalBytes > 0 ? Math.min(100, Math.round((tr.bytesDone / tr.totalBytes) * 100)) : tr.state === 'completed' ? 100 : 0
                    const needsMe = (tr.state === 'offered' || tr.state === 'previewed' || tr.state === 'needs_reapproval') && !tr.localApproved
                    return (
                        <div key={tr.id} className="px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass flex flex-col gap-1" data-testid={`project-transfer-row-${tr.id}`}>
                            <div className="flex items-center justify-between text-xs">
                                <span>{tr.role === 'source' ? t('settings.projectTransfer.roleSource') : t('settings.projectTransfer.roleTarget')} · {tr.finalName} · {byId.get(tr.peerDaemonId)?.name ?? tr.peerDaemonId}</span>
                                <span className="font-mono">{t(`settings.projectTransfer.state.${tr.state}`, { defaultValue: tr.state })}</span>
                            </div>
                            {!done && <div className="h-1.5 rounded bg-border-subtle overflow-hidden"><div className="h-full bg-accent-primary" style={{ width: `${pct}%` }} /></div>}
                            <div className="text-2xs text-text-muted">{formatBytes(tr.bytesDone)} / {formatBytes(tr.totalBytes)}{tr.publishedName ? ` · ${t('settings.projectTransfer.received', { name: tr.publishedName })}` : ''}{tr.errorCode ? ` · ${t('settings.projectTransfer.errorCode', { code: tr.errorCode })}` : ''}</div>
                            {!done && (
                                <div className="flex gap-2">
                                    {needsMe && tr.role === 'target' && (
                                        <Button variant="primary" size="sm" onClick={() => { void approve((tr as any).__machine, tr).then(refresh).catch(e => setError(e instanceof Error ? e.message : '')) }}>
                                            {t('settings.projectTransfer.approveSource', { machine: byId.get((tr as any).__machine)?.name ?? '' })}
                                        </Button>
                                    )}
                                    <Button variant="ghost" size="sm" onClick={() => { void cancelTransfer(tr) }}>{t('settings.projectTransfer.cancel')}</Button>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
