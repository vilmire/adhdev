import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { AlertBanner } from '../ui/AlertBanner'
import { call, type SendCommand } from './projectTransferApi'

/**
 * Wire contract of `driver_grants_get` / `driver_grants_set` (names mirror daemon-core;
 * no value imports from it). Design: docs/design/2026-11-04-computer-use-driver.md §4.4.
 */
export interface DriverGrantView {
    id: string
    title: string
    description: string
    granted: boolean
}

export interface DriverGrantsDriverView {
    type: string
    name: string
    providerVersion?: string
    activation: 'ready' | 'needs_approval' | 'disabled'
    stagedId?: string
    platformSupported: boolean
    grants: DriverGrantView[]
}

export interface DriverPermissionsMachine {
    id: string
    name: string
    online: boolean
}

export interface DriverPermissionsSectionProps {
    machines?: DriverPermissionsMachine[]
    sendCommand?: SendCommand
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed' | 'outdated'

/** Grants whose use needs an OS-level prerequisite (screen recording / accessibility). */
const OS_HINT_GRANTS = new Set(['screen', 'input'])

const asString = (v: unknown) => (typeof v === 'string' ? v : '')

/** A daemon without the verb answers `Unknown command: …` (as a reply or as a thrown error). */
const isUnknownCommand = (v: unknown) => /unknown command/i.test(asString(v))

function normalizeDriver(raw: any): DriverGrantsDriverView | null {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null
    const grants: DriverGrantView[] = Array.isArray(raw.grants)
        ? raw.grants
            .filter((g: any) => g && typeof g.id === 'string')
            .map((g: any) => ({ id: g.id, title: asString(g.title), description: asString(g.description), granted: g.granted === true }))
        : []
    return {
        type: raw.type,
        name: asString(raw.name) || raw.type,
        providerVersion: asString(raw.providerVersion) || undefined,
        activation: raw.activation === 'needs_approval' || raw.activation === 'disabled' ? raw.activation : 'ready',
        stagedId: asString(raw.stagedId) || undefined,
        platformSupported: raw.platformSupported !== false,
        grants,
    }
}

/** The set reply is the driver entry; tolerate it being wrapped as `{ driver }`. */
function driverFromReply(body: Record<string, any>): DriverGrantsDriverView | null {
    return normalizeDriver(body.driver ?? (typeof body.type === 'string' ? body : null))
}

export function DriverPermissionsSection({ machines: machinesProp, sendCommand: sendProp }: DriverPermissionsSectionProps = {}) {
    const { t, i18n } = useTranslation('common')
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
    const machine = machines.find(m => m.id === machineId)
    const online = machine?.online === true

    const [state, setState] = useState<LoadState>('idle')
    const [drivers, setDrivers] = useState<DriverGrantsDriverView[]>([])
    const [error, setError] = useState('')
    const [busy, setBusy] = useState<Set<string>>(new Set())
    // Guards against a slow reply of a previously selected machine landing in the new one.
    const machineRef = useRef('')
    machineRef.current = machineId

    const load = useCallback(async (id: string) => {
        setState('loading')
        setError('')
        try {
            const body = await call(sendRef.current, id, 'driver_grants_get', {})
            if (machineRef.current !== id) return
            if (isUnknownCommand(body.error)) { setState('outdated'); return }
            if (body.success === false || !Array.isArray(body.drivers)) { setState('failed'); return }
            setDrivers(body.drivers.map(normalizeDriver).filter((d: DriverGrantsDriverView | null): d is DriverGrantsDriverView => !!d && d.grants.length > 0))
            setState('ready')
        } catch (e) {
            if (machineRef.current !== id) return
            setState(isUnknownCommand((e as Error)?.message) ? 'outdated' : 'failed')
        }
    }, [])

    useEffect(() => {
        setDrivers([])
        setBusy(new Set())
        if (!machineId || !online) { setState('idle'); setError(''); return }
        void load(machineId)
    }, [machineId, online, load])

    const toggle = async (driver: DriverGrantsDriverView, grantId: string, checked: boolean) => {
        const id = machineId
        const key = `${driver.type}:${grantId}`
        const previous = driver
        const patch = (d: DriverGrantsDriverView): DriverGrantsDriverView => ({ ...d, grants: d.grants.map(g => (g.id === grantId ? { ...g, granted: checked } : g)) })
        setError('')
        setBusy(prev => new Set(prev).add(key))
        setDrivers(list => list.map(d => (d.type === driver.type ? patch(d) : d)))
        const rollback = (message: string) => {
            setDrivers(list => list.map(d => (d.type === driver.type ? { ...d, grants: d.grants.map(g => (g.id === grantId ? { ...g, granted: previous.grants.find(p => p.id === grantId)?.granted === true } : g)) } : d)))
            setError(message)
        }
        try {
            const body = await call(sendRef.current, id, 'driver_grants_set', { type: driver.type, grants: { [grantId]: checked } })
            if (machineRef.current !== id) return
            if (isUnknownCommand(body.error)) { rollback(t('settings.driverPermissions.needsUpdate')); return }
            if (body.success === false || typeof body.error === 'string') {
                const code = asString(body.code) || asString(body.error)
                rollback(`${t('settings.driverPermissions.saveFailed')}${code ? ` (${code})` : ''}`)
                return
            }
            const next = driverFromReply(body)
            if (next) setDrivers(list => list.map(d => (d.type === next.type ? { ...next, grants: next.grants.length ? next.grants : d.grants } : d)))
        } catch (e) {
            if (machineRef.current !== id) return
            rollback(isUnknownCommand((e as Error)?.message) ? t('settings.driverPermissions.needsUpdate') : t('settings.driverPermissions.saveFailed'))
        } finally {
            setBusy(prev => { const next = new Set(prev); next.delete(key); return next })
        }
    }

    const grantText = (g: DriverGrantView, field: 'title' | 'description') => {
        const key = `settings.driverPermissions.grants.${g.id}.${field}`
        return i18n.exists(key, { ns: 'common' }) ? t(key) : g[field]
    }

    if (machines.length === 0) {
        return <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="driver-permissions-no-machines">{t('settings.driverPermissions.noMachines')}</div>
    }

    const inputOn = drivers.some(d => d.grants.some(g => g.id === 'input' && g.granted))
    const warningText = (
        <>
            <span className="block">{t('settings.driverPermissions.warning.control')}</span>
            <span className="block mt-1">{t('settings.driverPermissions.warning.approval')}</span>
        </>
    )

    return (
        <div className="flex flex-col gap-3" data-testid="driver-permissions-section">
            {inputOn ? (
                <div data-testid="driver-permissions-warning-strong">
                    <AlertBanner variant="warning">{warningText}</AlertBanner>
                </div>
            ) : (
                <p className="text-xs text-text-muted m-0" data-testid="driver-permissions-warning">{warningText}</p>
            )}
            {error && <div data-testid="driver-permissions-error"><AlertBanner variant="error" onDismiss={() => setError('')}>{error}</AlertBanner></div>}

            {machines.length > 1 && (
                <label className="flex flex-col gap-1 text-xs">{t('settings.driverPermissions.machine')}
                    <select className="input" value={pickedId} onChange={e => setPickedId(e.target.value)} data-testid="driver-permissions-machine">
                        <option value="">—</option>
                        {machines.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.name}</option>)}
                    </select>
                </label>
            )}

            {!machineId && <div className="text-xs text-text-muted" data-testid="driver-permissions-choose">{t('settings.driverPermissions.chooseMachine')}</div>}
            {machineId && !online && <div className="text-xs text-text-muted" data-testid="driver-permissions-offline">{t('settings.driverPermissions.offline')}</div>}
            {machineId && online && state === 'loading' && <div className="text-xs text-text-muted" data-testid="driver-permissions-loading">{t('settings.driverPermissions.loading')}</div>}
            {machineId && online && state === 'outdated' && <div data-testid="driver-permissions-outdated"><AlertBanner variant="info">{t('settings.driverPermissions.needsUpdate')}</AlertBanner></div>}
            {machineId && online && state === 'failed' && (
                <div className="flex items-center gap-2" data-testid="driver-permissions-load-failed">
                    <AlertBanner variant="error">{t('settings.driverPermissions.loadFailed')}</AlertBanner>
                    <button type="button" className="btn btn-sm" onClick={() => { void load(machineId) }} data-testid="driver-permissions-retry">{t('settings.driverPermissions.retry')}</button>
                </div>
            )}
            {machineId && online && state === 'ready' && drivers.length === 0 && (
                <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="driver-permissions-empty">{t('settings.driverPermissions.empty')}</div>
            )}

            {online && state === 'ready' && drivers.map(driver => (
                <div key={driver.type} className="rounded-xl border border-border-subtle bg-bg-glass p-3 flex flex-col gap-2" data-testid={`driver-permissions-card-${driver.type}`}>
                    <div className="flex items-center gap-2 text-xs font-medium">
                        {driver.name}
                        {driver.providerVersion && <span className="text-2xs font-normal text-text-muted">v{driver.providerVersion}</span>}
                    </div>
                    {driver.activation === 'needs_approval' && (
                        <div data-testid={`driver-permissions-needs-approval-${driver.type}`}><AlertBanner variant="info">{t('settings.driverPermissions.needsApproval')}</AlertBanner></div>
                    )}
                    {!driver.platformSupported && (
                        <div className="text-2xs text-text-muted" data-testid={`driver-permissions-unsupported-${driver.type}`}>{t('settings.driverPermissions.platformUnsupported')}</div>
                    )}
                    {driver.grants.map(g => (
                        <label key={g.id} className="flex items-start gap-2 text-xs" data-testid={`driver-permissions-grant-${driver.type}-${g.id}`}>
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={g.granted}
                                disabled={!driver.platformSupported || busy.has(`${driver.type}:${g.id}`)}
                                onChange={e => { void toggle(driver, g.id, e.target.checked) }}
                                data-testid={`driver-permissions-toggle-${driver.type}-${g.id}`}
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">{grantText(g, 'title')}</span>
                                <span className="text-text-muted">{grantText(g, 'description')}</span>
                            </span>
                        </label>
                    ))}
                    {driver.grants.some(g => OS_HINT_GRANTS.has(g.id)) && (
                        <div className="text-2xs text-text-muted" data-testid={`driver-permissions-os-hint-${driver.type}`}>{t('settings.driverPermissions.osHint')}</div>
                    )}
                </div>
            ))}
        </div>
    )
}
