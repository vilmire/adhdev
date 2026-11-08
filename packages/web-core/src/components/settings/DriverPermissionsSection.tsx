import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { AlertBanner } from '../ui/AlertBanner'
import type { SendCommand } from './projectTransferApi'
import { DriverGrantCard, DriverGrantStatus, DriverGrantWarning, useDriverGrants } from './driverGrants'

export type { DriverGrantView, DriverGrantsDriverView } from './driverGrants'

export interface DriverPermissionsMachine {
    id: string
    name: string
    online: boolean
}

export interface DriverPermissionsSectionProps {
    machines?: DriverPermissionsMachine[]
    sendCommand?: SendCommand
}

/**
 * Settings entry point. Kept (rather than reduced to a pointer) so the standalone and cloud
 * Settings pages still work as a cross-machine overview; the per-machine Providers tab hosts
 * the same card, including the inline approve action.
 */
export function DriverPermissionsSection({ machines: machinesProp, sendCommand: sendProp }: DriverPermissionsSectionProps = {}) {
    const { t } = useTranslation('common')
    const baseDaemons = useBaseDaemons()
    const transport = useTransport()
    const sendRef = useRef<SendCommand>(sendProp ?? transport.sendCommand)
    sendRef.current = sendProp ?? transport.sendCommand

    const machines = useMemo<DriverPermissionsMachine[]>(() => {
        if (machinesProp) return machinesProp
        return (baseDaemons?.ides ?? [])
            .filter((d: any) => d?.type === 'adhdev-daemon' && typeof d?.id === 'string')
            .map((d: any) => ({
                id: d.id as string,
                name: getMachineDisplayName(d, { fallbackId: d.id }),
                online: (d.status ?? 'online') !== 'offline',
            }))
    }, [machinesProp, baseDaemons?.ides])

    const [pickedId, setPickedId] = useState('')
    // A single machine needs no picker: it is the choice.
    const machineId = machines.length === 1 ? machines[0]!.id : pickedId
    const online = machines.find(m => m.id === machineId)?.online === true
    const controller = useDriverGrants({ machineId, online, sendCommand: (...a) => sendRef.current(...a) })

    if (machines.length === 0) {
        return <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="driver-permissions-no-machines">{t('settings.driverPermissions.noMachines')}</div>
    }

    return (
        <div className="flex flex-col gap-3" data-testid="driver-permissions-section">
            <p className="text-xs text-text-muted m-0" data-testid="driver-permissions-providers-pointer">{t('settings.driverPermissions.providersPointer')}</p>
            <DriverGrantWarning drivers={controller.drivers} />
            {controller.error && <div data-testid="driver-permissions-error"><AlertBanner variant="error" onDismiss={() => controller.setError('')}>{controller.error}</AlertBanner></div>}

            {machines.length > 1 && (
                <label className="flex flex-col gap-1 text-xs">{t('settings.driverPermissions.machine')}
                    <select className="input" value={pickedId} onChange={e => setPickedId(e.target.value)} data-testid="driver-permissions-machine">
                        <option value="">—</option>
                        {machines.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.name}</option>)}
                    </select>
                </label>
            )}

            {!machineId && <div className="text-xs text-text-muted" data-testid="driver-permissions-choose">{t('settings.driverPermissions.chooseMachine')}</div>}
            {machineId && <DriverGrantStatus controller={controller} online={online} />}
            {online && controller.state === 'ready' && controller.drivers.map(d => <DriverGrantCard key={d.type} driver={d} controller={controller} />)}
        </div>
    )
}
