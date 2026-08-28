/**
 * seqscribe Beacon advisory badge (design §7.1, mission b60d70b8).
 *
 * Surfaces the two things the Beacon board can actually tell a user about a
 * machine (§7.1.0's reachable features ① and ③):
 *
 *   - "this machine is behind its peers by N entries"  (wake-up lag)
 *   - "this machine may hold the only copy of something" (sole-copy awareness)
 *
 * ── ★ Why 'unknown' gets its own rendering, and never the safe-looking one ──
 * §7.1.2.1: when the server truncated the board, the peer list we compared
 * against is a SUBSET of the fleet, so sole-copy judgement is DEFERRED. The
 * daemon encodes that as `verdict: 'unknown'` + `soleCopyDeferred: true`, and
 * this component must not launder it back into certainty in either direction:
 *
 *   - rendering it as "replicated" (or hiding the badge) tells the user their
 *     data is safe when nobody established that;
 *   - rendering it as "sole copy" invents a data-loss scare from missing data.
 *
 * So a deferred verdict renders as its own muted "can't tell" state. That is
 * the whole point of carrying a three-valued verdict to the UI rather than
 * collapsing it to a boolean at the boundary.
 *
 * ── ★ ADVISORY, never a gate (§5.7a) ───────────────────────────────────────
 * Nothing here blocks, disables, or warns-before an action. It is a badge and a
 * tooltip. `keyStaleAdvisory` in particular is display-only and empty in
 * production today (upstream P27 emits no `hints`).
 *
 * ── Deliberately small ──────────────────────────────────────────────────────
 * Badge + tooltip, no panel, no drill-down. Beacon data is advisory replication
 * detail; a machine card is not where a user debugs replication, and the full
 * numbers already live in `get_status_metadata` for anyone who needs them.
 *
 * ── Why age is computed here ────────────────────────────────────────────────
 * The payload carries `boardAt` (a stable instant), not an elapsed age, because
 * an age recomputed per report would make every status frame unique and defeat
 * the payload-hash dedup — see `toBeaconDiagnosticsSummary`. Render time is the
 * right place to turn the instant into "how old", and it is also more accurate.
 */

import { useTranslation } from 'react-i18next'
import type { BeaconDiagnosticsSummary } from '../types'
import { cn } from '../lib/utils'

/** Matches `BEACON_BOARD_TTL_MS` in daemon-core's seqscribe/beacon-diagnostics.ts. */
const BOARD_STALE_AFTER_MS = 30_000

export interface BeaconAdvisoryBadgeProps {
    beacon?: BeaconDiagnosticsSummary
    className?: string
}

export function BeaconAdvisoryBadge({ beacon, className }: BeaconAdvisoryBadgeProps) {
    const { t } = useTranslation()
    if (!beacon) return null

    const boardAtMs = beacon.boardAt ? Date.parse(beacon.boardAt) : Number.NaN
    const boardAgeMs = Number.isNaN(boardAtMs) ? null : Math.max(0, Date.now() - boardAtMs)
    // No board, or one older than the daemon's own TTL. An idle daemon's board
    // is SUPPOSED to age (the beacon only pushes after an append), so this is
    // "we don't have a fresh answer", not "something is wrong" — and it is why
    // a stale board renders nothing rather than a stale claim.
    const stale = boardAgeMs === null || boardAgeMs > BOARD_STALE_AFTER_MS

    const behind = beacon.maxBehind > 0 ? beacon.maxBehind : 0
    // ★ Only CONFIRMED sole copies count toward the alarming badge. A deferred
    // ('unknown') verdict is reported separately and never as data loss.
    const soleCopies = beacon.soleCopy.filter((c) => c.verdict === 'sole-copy')
    const deferred = beacon.soleCopyDeferred || beacon.soleCopy.some((c) => c.verdict === 'unknown')

    // Nothing worth a badge: caught up, nothing unreplicated, nothing deferred.
    if (stale || (behind === 0 && soleCopies.length === 0 && !deferred)) return null

    const worstPeer = beacon.peers[0]
    const tooltip = [
        behind > 0
            ? t('machine.card.beacon.behindTooltip', {
                  count: behind,
                  topic: worstPeer?.topics[0]?.topic ?? '',
              })
            : null,
        soleCopies.length > 0
            ? t('machine.card.beacon.soleCopyTooltip', {
                  count: soleCopies.length,
                  entries: soleCopies.reduce((sum, c) => sum + c.unreplicated, 0),
              })
            : null,
        // ★ The deferral is explained, not hidden: a user who sees "can't tell"
        // deserves to know it is a truncated board, not a broken machine.
        deferred ? t('machine.card.beacon.deferredTooltip') : null,
    ]
        .filter(Boolean)
        .join('\n')

    return (
        <span className={cn('inline-flex items-center gap-1', className)} title={tooltip}>
            {behind > 0 && (
                <span
                    className="text-4xs font-semibold px-[5px] py-px rounded bg-yellow-500/[0.08] border border-yellow-500/20 text-yellow-400"
                    data-testid="beacon-behind-badge"
                >
                    {t('machine.card.beacon.behindLabel', { count: behind })}
                </span>
            )}
            {soleCopies.length > 0 && (
                <span
                    className="text-4xs font-semibold px-[5px] py-px rounded bg-orange-500/[0.08] border border-orange-500/20 text-orange-400"
                    data-testid="beacon-sole-copy-badge"
                >
                    {t('machine.card.beacon.soleCopyLabel')}
                </span>
            )}
            {/*
              ★ Rendered ONLY when there is no confirmed sole copy to show. With
              both, the confirmed finding is the actionable one and a second
              "can't tell" chip would just add noise — the tooltip still says the
              board was truncated either way.
            */}
            {deferred && soleCopies.length === 0 && (
                <span
                    className="text-4xs font-semibold px-[5px] py-px rounded bg-gray-500/[0.08] border border-gray-500/20 text-text-secondary"
                    data-testid="beacon-deferred-badge"
                >
                    {t('machine.card.beacon.deferredLabel')}
                </span>
            )}
        </span>
    )
}

export default BeaconAdvisoryBadge
