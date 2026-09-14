/**
 * Display-only grace for the replica-degraded banner.
 *
 * `transcriptReplicaDegraded` on the chat-tail controller is the source of
 * truth and is set/cleared immediately (fallback, lease expiry, replica
 * re-apply). ChatPane delays RENDERING the banner so a replica that recovers
 * within this window never flashes the notice. Lease re-arm, legacy
 * resubscribe, and diagnostics are unaffected.
 */
import { useEffect, useState } from 'react'

/** How long the banner stays hidden after `transcriptReplicaDegraded` flips true. */
export const REPLICA_DEGRADED_BANNER_GRACE_MS = 5_000

/**
 * Pure form of the display rule: hide while degraded is false, and hide
 * while the elapsed time since it became true is still inside the grace.
 */
export function shouldShowReplicaDegradedBanner(
  degraded: boolean,
  elapsedMs: number,
  graceMs: number = REPLICA_DEGRADED_BANNER_GRACE_MS,
): boolean {
  return degraded && elapsedMs >= graceMs
}

/**
 * Banner visibility for ChatPane. `degraded` is the controller flag — this
 * hook never writes it. `resetKey` restarts grace when the pane's conversation
 * identity changes while the flag stays true (same ChatPane, new session).
 */
export function useReplicaDegradedBannerVisible(
  degraded: boolean,
  resetKey?: string,
  graceMs: number = REPLICA_DEGRADED_BANNER_GRACE_MS,
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!degraded) {
      setVisible(false)
      return
    }
    setVisible(false)
    const timer = setTimeout(() => {
      setVisible(true)
    }, graceMs)
    return () => clearTimeout(timer)
  }, [degraded, resetKey, graceMs])

  return visible
}
