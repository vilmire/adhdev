/**
 * protocol/dashboard-wire-version — the dashboard ↔ daemon wire version.
 *
 * Both dashboards (cloud over P2P, standalone over WS) state the version they
 * speak on every topic subscribe; the daemon states its own on the standalone
 * hello, on every keyed snapshot frame, and in the `protocol_mismatch` reply it
 * sends INSTEAD of state when the two differ. There is no dual-format serving:
 * a mismatched pair renders no state at all —
 *   - the page is older than the daemon → the page must reload (its bundle
 *     cannot read the daemon's frames);
 *   - the daemon is older than the page → the daemon must be updated.
 *
 * Bump this whenever a frame shape changes incompatibly; one release carries
 * the same value on both ends.
 *   1 — implicit (frames before versioning).
 *   2 — daemon.metadata deltas on the keyed-doc engine (2026-09-29).
 */
export const DASHBOARD_WIRE_VERSION = 2

export type DashboardWireCompat = 'ok' | 'reload_required' | 'daemon_update_required'

/** How a page speaking `pageVersion` relates to a daemon speaking `daemonVersion` (absent = 1). */
export function compareDashboardWireVersion(pageVersion: number, daemonVersion: number | null | undefined): DashboardWireCompat {
    const daemon = typeof daemonVersion === 'number' && Number.isFinite(daemonVersion) ? daemonVersion : 1
    if (daemon === pageVersion) return 'ok'
    return daemon > pageVersion ? 'reload_required' : 'daemon_update_required'
}
