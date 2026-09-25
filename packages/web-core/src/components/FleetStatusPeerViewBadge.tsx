/**
 * Small machine-card cross-check for the Phase 4 Stage 2 fleet.status SUB view.
 *
 * ★ User-facing rule (owner, 2026-09-25): the internal sync engine's name never
 * reaches the UI, and the healthy case renders NOTHING — a badge on every
 * machine that only says "the cross-check agrees" is noise. Only a real
 * disagreement shows, as a plain "sync delayed" chip with a plain tooltip.
 *
 * The WS status remains the routing/push source of truth for this stage. This
 * badge does not replace or gate it: it shows that another daemon received a
 * fresh fixed-key status for the same machine, and changes tone when that peer
 * observation disagrees with the WS machine state or top-level session count.
 * Full details stay in a native tooltip; there is intentionally no panel.
 */

import { useTranslation } from 'react-i18next'
import type { FleetStatusPeerEntry } from '../types'
import { cn } from '../lib/utils'

/** Status is written on the 5s P2P tick; six ticks is ample freshness headroom. */
export const FLEET_STATUS_PEER_FRESH_MS = 30_000

export interface FleetStatusPeerViewBadgeProps {
    peer?: FleetStatusPeerEntry
    wsOnline: boolean
    wsSessionCount: number
    className?: string
    /** Deterministic render-time override for tests. */
    now?: number
}

export function FleetStatusPeerViewBadge({
    peer,
    wsOnline,
    wsSessionCount,
    className,
    now = Date.now(),
}: FleetStatusPeerViewBadgeProps) {
    const { t } = useTranslation()
    if (!peer) return null

    const observedAt = Date.parse(peer.at)
    const ageMs = Number.isNaN(observedAt) ? Number.POSITIVE_INFINITY : Math.max(0, now - observedAt)
    if (ageMs > FLEET_STATUS_PEER_FRESH_MS) return null

    const peerSessionCount = peer.sessionCounts.ideCount
        + peer.sessionCounts.cliCount
        + peer.sessionCounts.acpCount
    const wsState = wsOnline ? 'online' : 'offline'
    const diverged = peer.onlineState !== wsState || peerSessionCount !== wsSessionCount
    // Healthy (the two views agree): nothing to tell the user.
    if (!diverged) return null
    const stateLabel = (state: string) =>
        state === 'online' ? t('machine.card.fleetPeer.stateOnline')
            : state === 'offline' ? t('machine.card.fleetPeer.stateOffline')
                : state
    const tooltip = t('machine.card.fleetPeer.tooltip', {
        wsState: stateLabel(wsState),
        wsCount: wsSessionCount,
        peerState: stateLabel(peer.onlineState),
        peerCount: peerSessionCount,
        age: Math.floor(ageMs / 1000),
    })

    return (
        <span
            className={cn(
                'text-4xs font-semibold px-[5px] py-px rounded border',
                diverged
                    ? 'bg-yellow-500/[0.08] border-yellow-500/20 text-yellow-400'
                    : 'bg-cyan-500/[0.08] border-cyan-500/20 text-cyan-400',
                className,
            )}
            title={tooltip}
            data-testid="fleet-status-peer-view-badge"
            data-diverged={diverged ? 'true' : 'false'}
        >
            {t('machine.card.fleetPeer.divergedLabel')}
        </span>
    )
}

export default FleetStatusPeerViewBadge
