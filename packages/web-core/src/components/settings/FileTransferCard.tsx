/**
 * FileTransferCard — the one compact "File transfer" block of Settings.
 *
 * - a small table: machines as rows, three plain-language switches per machine
 *   (remote project attach / relay fallback / agents may send new folders without asking);
 * - a "Send files" button that opens the manual send form in a dialog;
 * - the latest few transfers (collapsed, "Show all").
 * Each explanation is written once (an info tip on the column header).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { AlertBanner } from '../ui/AlertBanner'
import Button from '../ui/Button'
import Dialog from '../ui/Dialog'
import { InfoTip } from '../ui/InfoTip'
import { Switch } from '../ui/Switch'
import { ProjectTransferSection, type ProjectTransferMachine } from './ProjectTransferSection'
import { call, type SendCommand } from './projectTransferApi'

export const REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND = 'remote_project_attach_settings'

type SettingKey = 'attach' | 'relay' | 'agents'
interface MachineSettings { attach: boolean; relay: boolean; agents: boolean; transferSupported: boolean }

export interface FileTransferCardProps {
    machines?: ProjectTransferMachine[]
    sendCommand?: SendCommand
    pollMs?: number
}

function useTransferMachines(machinesProp: ProjectTransferMachine[] | undefined): ProjectTransferMachine[] {
    const baseDaemons = useBaseDaemons()
    return useMemo<ProjectTransferMachine[]>(() => {
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
}

/** "Send files" button + the dialog holding the manual send form. */
export function SendFilesButton({ machines, sendCommand, initialFromId, size = 'md' }: {
    machines?: ProjectTransferMachine[]
    sendCommand?: SendCommand
    initialFromId?: string
    size?: 'sm' | 'md'
}) {
    const { t } = useTranslation('common')
    const [open, setOpen] = useState(false)
    return (
        <>
            <Button variant="secondary" size={size} onClick={() => setOpen(true)} data-testid="send-files-open">{t('settings.fileTransfer.sendFiles')}</Button>
            <Dialog open={open} onClose={() => setOpen(false)} size="lg" title={t('settings.fileTransfer.sendFiles')}>
                <div data-testid="send-files-dialog">
                    <ProjectTransferSection show="form" machines={machines} sendCommand={sendCommand} initialFromId={initialFromId} />
                </div>
            </Dialog>
        </>
    )
}

export function FileTransferCard({ machines: machinesProp, sendCommand: sendProp, pollMs }: FileTransferCardProps = {}) {
    const { t } = useTranslation('common')
    const transport = useTransport()
    const sendRef = useRef<SendCommand>(sendProp ?? transport.sendCommand)
    sendRef.current = sendProp ?? transport.sendCommand
    const machines = useTransferMachines(machinesProp)

    const [settings, setSettings] = useState<Record<string, MachineSettings>>({})
    const [saving, setSaving] = useState<Record<string, boolean>>({})
    const [error, setError] = useState('')

    const machineKey = machines.map(m => `${m.id}:${m.online ? 'on' : 'off'}`).join('|')
    const refreshAll = useCallback(async () => {
        for (const m of machines) {
            if (!m.online) continue
            const [attach, caps] = await Promise.all([
                call(sendRef.current, m.id, REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND, { action: 'get' }).catch(() => ({} as Record<string, any>)),
                call(sendRef.current, m.id, 'project_transfer_capabilities', {}).catch(() => ({} as Record<string, any>)),
            ])
            setSettings(prev => ({
                ...prev,
                [m.id]: {
                    attach: attach.success === true ? Boolean(attach.allowRemoteProjectAttach ?? attach.enabled) : (prev[m.id]?.attach ?? false),
                    relay: caps.relayAllowed !== false,
                    agents: caps.agentAutoApprove === true,
                    transferSupported: caps.supported === true,
                },
            }))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [machineKey])
    useEffect(() => { void refreshAll() }, [refreshAll])

    const change = async (id: string, key: SettingKey, next: boolean) => {
        const prev = settings[id]
        if (!prev) return
        const savingKey = `${id}:${key}`
        setError('')
        setSaving(s => ({ ...s, [savingKey]: true }))
        setSettings(s => ({ ...s, [id]: { ...prev, [key]: next } }))
        try {
            let ok = false
            let confirmed = next
            if (key === 'attach') {
                const body = await call(sendRef.current, id, REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND, { action: 'set', enabled: next })
                ok = body.success === true
                confirmed = Boolean(body.allowRemoteProjectAttach ?? body.enabled ?? next)
                if (!ok && typeof body.error === 'string' && body.error) { setError(body.error); throw new Error(body.error) }
            } else if (key === 'relay') {
                const body = await call(sendRef.current, id, 'project_transfer_set_relay', { allowRelay: next })
                ok = body.success === true
                confirmed = body.relayAllowed !== false
            } else {
                const body = await call(sendRef.current, id, 'project_transfer_set_agent_auto_approve', { allow: next })
                ok = body.success === true
                confirmed = body.agentAutoApprove === true
            }
            if (!ok) throw new Error('save failed')
            setSettings(s => ({ ...s, [id]: { ...(s[id] ?? prev), [key]: confirmed } }))
        } catch (e) {
            setSettings(s => ({ ...s, [id]: prev }))
            setError(prevErr => prevErr || t('settings.fileTransfer.saveFailed'))
            void e
        } finally {
            setSaving(s => ({ ...s, [savingKey]: false }))
        }
    }

    const columns: Array<{ key: SettingKey; label: string; tip: string }> = [
        { key: 'attach', label: t('settings.fileTransfer.columns.attach'), tip: t('settings.fileTransfer.tips.attach') },
        { key: 'relay', label: t('settings.fileTransfer.columns.relay'), tip: t('settings.fileTransfer.tips.relay') },
        { key: 'agents', label: t('settings.fileTransfer.columns.agents'), tip: t('settings.fileTransfer.tips.agents') },
    ]

    return (
        <div className="flex flex-col gap-3" data-testid="file-transfer-card">
            <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-text-muted m-0">{t('settings.fileTransfer.intro')}</p>
                <SendFilesButton machines={machinesProp} sendCommand={sendProp} size="sm" />
            </div>
            {error && <AlertBanner variant="error">{error}</AlertBanner>}

            {machines.length === 0 ? (
                <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="file-transfer-no-machines">
                    {t('settings.fileTransfer.noMachines')}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-glass">
                    <table className="w-full text-xs border-collapse" data-testid="file-transfer-table">
                        <thead>
                            <tr className="text-left text-text-muted">
                                <th className="px-3 py-2 font-medium">{t('settings.fileTransfer.columns.machine')}</th>
                                {columns.map(c => (
                                    <th key={c.key} className="px-3 py-2 font-medium">
                                        <span className="inline-flex items-center gap-1">{c.label}<InfoTip content={c.tip} /></span>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {machines.map(m => {
                                const s = settings[m.id]
                                return (
                                    <tr key={m.id} className="border-t border-border-subtle" data-testid={`file-transfer-row-${m.id}`}>
                                        <td className="px-3 py-2 font-medium text-text-primary">
                                            {m.name}
                                            {!m.online && <span className="ml-1.5 text-2xs font-normal text-text-muted">{t('settings.fileTransfer.offline')}</span>}
                                        </td>
                                        {columns.map(c => {
                                            const unavailable = !m.online || !s || (c.key !== 'attach' && !s.transferSupported)
                                            return (
                                                <td key={c.key} className="px-3 py-2">
                                                    <Switch
                                                        size="sm"
                                                        checked={Boolean(s?.[c.key])}
                                                        disabled={unavailable}
                                                        busy={Boolean(saving[`${m.id}:${c.key}`])}
                                                        onChange={v => { void change(m.id, c.key, v) }}
                                                        aria-label={`${c.label} — ${m.name}`}
                                                    />
                                                </td>
                                            )
                                        })}
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <ProjectTransferSection show="history" machines={machinesProp} sendCommand={sendProp} pollMs={pollMs} />
        </div>
    )
}
