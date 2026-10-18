import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { AlertBanner } from '../ui/AlertBanner'
import { ToggleRow } from './ToggleRow'

export const REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND = 'remote_project_attach_settings'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface RemoteProjectAttachMachine {
    id: string
    name?: string | null
    nickname?: string | null
    machineNickname?: string | null
    hostname?: string | null
    status?: string
    online?: boolean
}

export interface RemoteProjectAttachSectionProps {
    machines?: RemoteProjectAttachMachine[]
    sendCommand?: SendCommand
}

function isMachineOffline(machine: RemoteProjectAttachMachine): boolean {
    if (typeof machine.online === 'boolean') return !machine.online
    return machine.status === 'offline'
}

function unwrapCommandResult(raw: unknown): Record<string, any> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const outer = raw as Record<string, any>
    if (outer.result && typeof outer.result === 'object' && !Array.isArray(outer.result)) {
        return outer.result as Record<string, any>
    }
    return outer
}

export function RemoteProjectAttachSection({
    machines: machinesProp,
    sendCommand: sendCommandProp,
}: RemoteProjectAttachSectionProps = {}) {
    const { t } = useTranslation('common')
    const baseDaemons = useBaseDaemons()
    const transport = useTransport()

    const resolvedMachines = useMemo<RemoteProjectAttachMachine[]>(() => {
        if (machinesProp !== undefined) return machinesProp
        const ides = baseDaemons?.ides ?? []
        return ides
            .filter((d: any) => d?.type === 'adhdev-daemon' && typeof d?.id === 'string')
            .map((d: any) => ({
                id: d.id,
                nickname: d.nickname ?? null,
                machineNickname: d.machineNickname ?? null,
                hostname: d.hostname ?? d.machine?.hostname ?? null,
                status: d.status ?? 'online',
            }))
    }, [machinesProp, baseDaemons?.ides])

    const sendRef = useRef<SendCommand>(sendCommandProp ?? transport.sendCommand)
    sendRef.current = sendCommandProp ?? transport.sendCommand

    const [enabledByMachine, setEnabledByMachine] = useState<Record<string, boolean>>({})
    const [savingByMachine, setSavingByMachine] = useState<Record<string, boolean>>({})
    const [error, setError] = useState('')

    const machineKey = useMemo(
        () => resolvedMachines.map(m => `${m.id}:${isMachineOffline(m) ? 'offline' : 'online'}`).join('|'),
        [resolvedMachines],
    )

    const refreshAll = useCallback(async () => {
        for (const machine of resolvedMachines) {
            if (isMachineOffline(machine)) continue
            try {
                const raw = await sendRef.current(machine.id, REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND, { action: 'get' })
                const body = unwrapCommandResult(raw)
                if (body?.success === true) {
                    const nextEnabled = Boolean(body.allowRemoteProjectAttach ?? body.enabled)
                    setEnabledByMachine(prev => (prev[machine.id] === nextEnabled ? prev : { ...prev, [machine.id]: nextEnabled }))
                }
            } catch {
                // Default OFF when daemon is offline or transport is unavailable
            }
        }
    }, [resolvedMachines])

    useEffect(() => {
        void refreshAll()
    }, [machineKey, refreshAll])

    const handleToggle = async (daemonId: string, nextEnabled: boolean) => {
        setError('')
        setSavingByMachine(prev => ({ ...prev, [daemonId]: true }))
        try {
            const raw = await sendRef.current(daemonId, REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND, {
                action: 'set',
                enabled: nextEnabled,
            })
            const body = unwrapCommandResult(raw)
            if (body?.success === true) {
                const confirmed = Boolean(body.allowRemoteProjectAttach ?? body.enabled ?? nextEnabled)
                setEnabledByMachine(prev => ({ ...prev, [daemonId]: confirmed }))
            } else {
                setError(typeof body?.error === 'string' && body.error ? body.error : t('settings.remoteProjectAttach.saveFailed'))
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings.remoteProjectAttach.saveFailed'))
        } finally {
            setSavingByMachine(prev => ({ ...prev, [daemonId]: false }))
        }
    }

    return (
        <div className="flex flex-col gap-3" data-testid="remote-project-attach-section">
            <p className="text-xs text-text-muted m-0" data-testid="remote-project-attach-both-note">
                {t('settings.remoteProjectAttach.bothMachinesNote')}
            </p>

            {error && (
                <div data-testid="remote-project-attach-error">
                    <AlertBanner variant="error">{error}</AlertBanner>
                </div>
            )}

            {resolvedMachines.length === 0 ? (
                <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass">
                    {t('settings.remoteProjectAttach.noMachines')}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {resolvedMachines.map(machine => {
                        const displayName = machine.name?.trim() || getMachineDisplayName(machine, { fallbackId: machine.id })
                        const checked = Boolean(enabledByMachine[machine.id])
                        const isOffline = isMachineOffline(machine)
                        const isSaving = Boolean(savingByMachine[machine.id])
                        return (
                            <div
                                key={machine.id}
                                className="px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass"
                                data-testid={`remote-project-attach-row-${machine.id}`}
                            >
                                <ToggleRow
                                    label={displayName}
                                    description={t('settings.remoteProjectAttach.rowDescription')}
                                    descriptionInline
                                    checked={checked}
                                    disabled={isOffline || isSaving}
                                    onChange={value => { void handleToggle(machine.id, value) }}
                                    extra={
                                        <span className="font-mono text-2xs text-text-muted">
                                            {isOffline
                                                ? t('settings.remoteProjectAttach.statusOffline')
                                                : checked
                                                    ? t('settings.remoteProjectAttach.statusOn')
                                                    : t('settings.remoteProjectAttach.statusOff')}
                                        </span>
                                    }
                                />
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
