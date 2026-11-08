import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertBanner } from '../ui/AlertBanner'
import { call, type SendCommand } from './projectTransferApi'
import { ASSISTANT_STAGED_COMMAND, parseResolveOutcomes } from '../dashboard/assistant-staged'

/**
 * Wire contract of `driver_grants_get` / `driver_grants_set` (names mirror daemon-core;
 * no value imports from it). Design: docs/design/2026-11-04-computer-use-driver.md §4.4.
 * Shared by the Settings section and the machine Providers tab.
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

export type DriverGrantsLoadState = 'idle' | 'loading' | 'ready' | 'failed' | 'outdated'

/** Grants whose use needs an OS-level prerequisite (screen recording / accessibility). */
const OS_HINT_GRANTS = new Set(['screen', 'input'])

const asString = (v: unknown) => (typeof v === 'string' ? v : '')

/** A daemon without the verb answers `Unknown command: …` (as a reply or as a thrown error). */
const isUnknownCommand = (v: unknown) => /unknown command/i.test(asString(v))

export function normalizeDriver(raw: any): DriverGrantsDriverView | null {
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

function parseDriverList(body: Record<string, any>): DriverGrantsDriverView[] | null {
    if (body.success === false || !Array.isArray(body.drivers)) return null
    return body.drivers.map(normalizeDriver).filter((d: DriverGrantsDriverView | null): d is DriverGrantsDriverView => !!d && d.grants.length > 0)
}

export interface DriverGrantsController {
    state: DriverGrantsLoadState
    drivers: DriverGrantsDriverView[]
    error: string
    setError: (message: string) => void
    busy: ReadonlySet<string>
    approving: ReadonlySet<string>
    reload: () => void
    toggle: (driver: DriverGrantsDriverView, grantId: string, checked: boolean) => Promise<void>
    approve: (driver: DriverGrantsDriverView) => Promise<void>
}

export function useDriverGrants(options: { machineId: string; online: boolean; sendCommand: SendCommand }): DriverGrantsController {
    const { machineId, online, sendCommand } = options
    const { t } = useTranslation('common')
    const sendRef = useRef<SendCommand>(sendCommand)
    sendRef.current = sendCommand
    const [state, setState] = useState<DriverGrantsLoadState>('idle')
    const [drivers, setDrivers] = useState<DriverGrantsDriverView[]>([])
    const [error, setError] = useState('')
    const [busy, setBusy] = useState<Set<string>>(new Set())
    const [approving, setApproving] = useState<Set<string>>(new Set())
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
            const list = parseDriverList(body)
            if (!list) { setState('failed'); return }
            setDrivers(list)
            setState('ready')
        } catch (e) {
            if (machineRef.current !== id) return
            setState(isUnknownCommand((e as Error)?.message) ? 'outdated' : 'failed')
        }
    }, [])

    useEffect(() => {
        setDrivers([])
        setBusy(new Set())
        setApproving(new Set())
        if (!machineId || !online) { setState('idle'); setError(''); return }
        void load(machineId)
    }, [machineId, online, load])

    const reload = useCallback(() => { if (machineId) void load(machineId) }, [machineId, load])

    const adopt = (next: DriverGrantsDriverView) =>
        setDrivers(list => list.map(d => (d.type === next.type ? { ...next, grants: next.grants.length ? next.grants : d.grants } : d)))

    const toggle = async (driver: DriverGrantsDriverView, grantId: string, checked: boolean) => {
        const id = machineId
        const key = `${driver.type}:${grantId}`
        const previous = driver.grants.find(g => g.id === grantId)?.granted === true
        setError('')
        setBusy(prev => new Set(prev).add(key))
        setDrivers(list => list.map(d => (d.type === driver.type
            ? { ...d, grants: d.grants.map(g => (g.id === grantId ? { ...g, granted: checked } : g)) }
            : d)))
        const rollback = (message: string) => {
            setDrivers(list => list.map(d => (d.type === driver.type
                ? { ...d, grants: d.grants.map(g => (g.id === grantId ? { ...g, granted: previous } : g)) }
                : d)))
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
            if (next) adopt(next)
        } catch (e) {
            if (machineRef.current !== id) return
            if (isUnknownCommand((e as Error)?.message)) { rollback(t('settings.driverPermissions.needsUpdate')); return }
            // A slow daemon can answer after the transport gave up (a P2P write timed out at 30 s
            // while the write itself landed). Only report a failure if a fresh read says it did not land.
            let confirmed: DriverGrantsDriverView | undefined
            try {
                const list = parseDriverList(await call(sendRef.current, id, 'driver_grants_get', {}))
                confirmed = list?.find(d => d.type === driver.type)
            } catch { /* unreadable: treat as not confirmed */ }
            if (machineRef.current !== id) return
            if (confirmed && confirmed.grants.find(g => g.id === grantId)?.granted === checked) adopt(confirmed)
            else rollback(t('settings.driverPermissions.saveFailed'))
        } finally {
            setBusy(prev => { const next = new Set(prev); next.delete(key); return next })
        }
    }

    /** Resolves the staged activation — the same command the assistant panel's Apply uses. Never automatic. */
    const approve = async (driver: DriverGrantsDriverView) => {
        const id = machineId
        const stagedId = driver.stagedId
        if (!stagedId) return
        setError('')
        setApproving(prev => new Set(prev).add(driver.type))
        try {
            const raw = await sendRef.current(id, ASSISTANT_STAGED_COMMAND, { id: stagedId, decision: 'apply' })
            if (machineRef.current !== id) return
            const outcome = parseResolveOutcomes(raw, [stagedId])[stagedId]
            await load(id)
            // After the re-read: load() clears the error line.
            if (!outcome?.ok) setError(`${t('settings.driverPermissions.approveFailed')}${outcome?.code ? ` (${outcome.code})` : ''}`)
        } catch (e) {
            if (machineRef.current !== id) return
            setError(`${t('settings.driverPermissions.approveFailed')}${(e as Error)?.message ? ` (${(e as Error).message})` : ''}`)
        } finally {
            setApproving(prev => { const next = new Set(prev); next.delete(driver.type); return next })
        }
    }

    return { state, drivers, error, setError, busy, approving, reload, toggle, approve }
}

export function DriverGrantWarning({ drivers }: { drivers: DriverGrantsDriverView[] }) {
    const { t } = useTranslation('common')
    const inputOn = drivers.some(d => d.grants.some(g => g.id === 'input' && g.granted))
    const warningText = (
        <>
            <span className="block">{t('settings.driverPermissions.warning.control')}</span>
            <span className="block mt-1">{t('settings.driverPermissions.warning.approval')}</span>
        </>
    )
    return inputOn ? (
        <div data-testid="driver-permissions-warning-strong">
            <AlertBanner variant="warning">{warningText}</AlertBanner>
        </div>
    ) : (
        <p className="text-xs text-text-muted m-0" data-testid="driver-permissions-warning">{warningText}</p>
    )
}

/** One driver: name/version, activation state, grant toggles, and the inline approve action. */
export function DriverGrantCard({ driver, controller }: { driver: DriverGrantsDriverView; controller: DriverGrantsController }) {
    const { t, i18n } = useTranslation('common')
    const { busy, approving, toggle, approve } = controller
    const grantText = (g: DriverGrantView, field: 'title' | 'description') => {
        const key = `settings.driverPermissions.grants.${g.id}.${field}`
        return i18n.exists(key, { ns: 'common' }) ? t(key) : g[field]
    }
    const anyOn = driver.grants.some(g => g.granted)
    return (
        <div className="rounded-xl border border-border-subtle bg-bg-glass p-3 flex flex-col gap-2" data-testid={`driver-permissions-card-${driver.type}`}>
            <div className="flex items-center gap-2 text-xs font-medium">
                {driver.name}
                {driver.providerVersion && <span className="text-2xs font-normal text-text-muted">v{driver.providerVersion}</span>}
                <span className="text-2xs font-normal text-text-muted ml-auto" data-testid={`driver-permissions-activation-${driver.type}`}>
                    {t(`settings.driverPermissions.activation.${driver.activation}`)}
                </span>
            </div>
            {driver.activation === 'needs_approval' && (
                <div className="flex flex-col gap-2" data-testid={`driver-permissions-needs-approval-${driver.type}`}>
                    <AlertBanner variant="info">
                        {driver.stagedId
                            ? t('settings.driverPermissions.needsApproval')
                            : t('settings.driverPermissions.needsApprovalNoRequest')}
                    </AlertBanner>
                    {driver.stagedId && (
                        <div>
                            <button
                                type="button"
                                className="btn btn-sm"
                                disabled={approving.has(driver.type) || !driver.platformSupported || !anyOn}
                                onClick={() => { void approve(driver) }}
                                data-testid={`driver-permissions-approve-${driver.type}`}
                            >{t('settings.driverPermissions.approveAndEnable')}</button>
                            {!anyOn && <span className="text-2xs text-text-muted ml-2">{t('settings.driverPermissions.approveNeedsGrant')}</span>}
                        </div>
                    )}
                </div>
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
    )
}

/** Load/offline/outdated/failed/empty status lines shared by every host of the cards. */
export function DriverGrantStatus({ controller, online }: { controller: DriverGrantsController; online: boolean }) {
    const { t } = useTranslation('common')
    const { state, drivers, reload } = controller
    return (
        <>
            {!online && <div className="text-xs text-text-muted" data-testid="driver-permissions-offline">{t('settings.driverPermissions.offline')}</div>}
            {online && state === 'loading' && <div className="text-xs text-text-muted" data-testid="driver-permissions-loading">{t('settings.driverPermissions.loading')}</div>}
            {online && state === 'outdated' && <div data-testid="driver-permissions-outdated"><AlertBanner variant="info">{t('settings.driverPermissions.needsUpdate')}</AlertBanner></div>}
            {online && state === 'failed' && (
                <div className="flex items-center gap-2" data-testid="driver-permissions-load-failed">
                    <AlertBanner variant="error">{t('settings.driverPermissions.loadFailed')}</AlertBanner>
                    <button type="button" className="btn btn-sm" onClick={reload} data-testid="driver-permissions-retry">{t('settings.driverPermissions.retry')}</button>
                </div>
            )}
            {online && state === 'ready' && drivers.length === 0 && (
                <div className="text-xs text-text-muted px-3.5 py-3 rounded-xl border border-border-subtle bg-bg-glass" data-testid="driver-permissions-empty">{t('settings.driverPermissions.empty')}</div>
            )}
        </>
    )
}

/** Machine-scoped panel: warning, error, status and one card per driver. Used by the Providers tab. */
export function DriverGrantsPanel({ machineId, online = true, sendCommand }: { machineId: string; online?: boolean; sendCommand: SendCommand }) {
    const controller = useDriverGrants({ machineId, online, sendCommand })
    return (
        <div className="flex flex-col gap-3" data-testid="driver-grants-panel">
            <DriverGrantWarning drivers={controller.drivers} />
            {controller.error && <div data-testid="driver-permissions-error"><AlertBanner variant="error" onDismiss={() => controller.setError('')}>{controller.error}</AlertBanner></div>}
            <DriverGrantStatus controller={controller} online={online} />
            {online && controller.state === 'ready' && controller.drivers.map(d => <DriverGrantCard key={d.type} driver={d} controller={controller} />)}
        </div>
    )
}
