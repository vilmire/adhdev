/**
 * dashboard-wire-compat — whether this page and each daemon speak the same
 * dashboard wire version (mesh-shared protocol/dashboard-wire-version.ts).
 *
 * Fed by SubscriptionManager: a daemon's `protocol_mismatch` reply, and the
 * `wireVersion` every keyed snapshot frame carries (a snapshot without one is a
 * pre-versioning daemon). A mismatched daemon's frames are never rendered —
 * there is no dual-format serving. DashboardWireCompatOverlay renders the
 * verdict: the page reloads (a daemon is newer) or daemons need updating.
 */
import { compareDashboardWireVersion, DASHBOARD_WIRE_VERSION, type DashboardWireCompat } from '@adhdev/mesh-shared'

export interface DashboardWireCompatState {
    /** Some daemon speaks a newer version than this page. */
    reloadRequired: boolean
    /** Daemons that speak an older version than this page. */
    daemonUpdateRequired: string[]
}

const byDaemon = new Map<string, DashboardWireCompat>()
const listeners = new Set<() => void>()
let snapshot: DashboardWireCompatState = { reloadRequired: false, daemonUpdateRequired: [] }

function publish(): void {
    const outdated: string[] = []
    let reloadRequired = false
    for (const [daemonId, compat] of byDaemon) {
        if (compat === 'reload_required') reloadRequired = true
        else if (compat === 'daemon_update_required') outdated.push(daemonId)
    }
    outdated.sort()
    if (reloadRequired === snapshot.reloadRequired && outdated.join('\n') === snapshot.daemonUpdateRequired.join('\n')) return
    snapshot = { reloadRequired, daemonUpdateRequired: outdated }
    for (const listener of listeners) listener()
}

/** Record what `daemonId` speaks; returns the verdict (non-`ok` = do not render its frames). */
export function noteDaemonWireVersion(daemonId: string, daemonWireVersion: number | null | undefined): DashboardWireCompat {
    const compat = compareDashboardWireVersion(DASHBOARD_WIRE_VERSION, daemonWireVersion)
    if (compat === 'ok') byDaemon.delete(daemonId)
    else byDaemon.set(daemonId, compat)
    publish()
    return compat
}

/** The current verdict for `daemonId` (`ok` until it says otherwise). */
export function daemonWireCompat(daemonId: string): DashboardWireCompat {
    return byDaemon.get(daemonId) ?? 'ok'
}

export function getDashboardWireCompat(): DashboardWireCompatState {
    return snapshot
}

export function subscribeDashboardWireCompat(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

/** Test-only: forget every verdict. */
export function __resetDashboardWireCompatForTest(): void {
    byDaemon.clear()
    publish()
}
