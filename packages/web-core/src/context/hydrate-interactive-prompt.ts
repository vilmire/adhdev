/**
 * hydrate-interactive-prompt — MULTISELECT-REMOTE-DEADLOCK fix, pure core.
 *
 * Applies an `agent:waiting_choice` event's InteractivePrompt onto the matching
 * session entry's `activeInteractivePrompt`, so the STRUCTURED picker
 * (InteractivePromptModal) can render even when the P2P rich status sync — the
 * only path that used to carry this field — is degraded or absent.
 *
 * Without this, a degraded transport left `activeInteractivePrompt` empty, the
 * session resolved to `waiting_approval`, and the dashboard fell back to the raw
 * ApprovalBanner. That banner's only answer verb is a single-select
 * `'{index}\r'` injection, which cannot submit a multi-select checkbox picker:
 * every remote tap silently toggled a box and submitted nothing, wedging the
 * session (and any mesh task queued behind it) forever.
 *
 * Kept React-free so the merge semantics below are directly testable.
 */
import type { DaemonData } from '../types'
import type { InteractivePrompt } from '../interactive-prompt/types'

/** Identity keys an event's `targetSessionId` may legitimately match. */
function entryMatchesSession(entry: DaemonData, sessionId: string): boolean {
  return entry.id === sessionId
    || entry.sessionId === sessionId
    || entry.instanceId === sessionId
}

/**
 * Return a new `ides` array with `sessionId`'s `activeInteractivePrompt` set to
 * `prompt`, or the SAME array reference when nothing changed.
 *
 * Referential stability matters: this runs inside a `setIdes` updater on every
 * `waiting_choice` event, and returning a fresh array for a no-op would re-render
 * the whole dashboard tree on a duplicate event.
 *
 * Rules:
 *   * Only EXISTING entries are touched — an event never creates a session. A
 *     `waiting_choice` for an unknown id is dropped (the status snapshot is the
 *     authority on which sessions exist).
 *   * An already-present prompt with the SAME promptId is left alone. The status
 *     snapshot's copy is authoritative and may be strictly richer (the multi-
 *     question capture repair upgrades `multiSelect` on later ticks — see
 *     readFocusedClaudeTuiQuestion); overwriting it with the event's frozen
 *     copy would undo that repair. This path exists to fill a GAP, not to win
 *     races against the snapshot.
 *   * A DIFFERENT promptId does overwrite: that is a genuinely new question, and
 *     leaving the stale one up would render the wrong prompt.
 */
export function hydrateInteractivePromptIntoIdes(
  ides: DaemonData[],
  sessionId: string,
  prompt: InteractivePrompt,
): DaemonData[] {
  const target = sessionId.trim()
  if (!target) return ides

  let changed = false
  const next = ides.map(entry => {
    if (!entryMatchesSession(entry, target)) return entry
    const existing = entry.activeInteractivePrompt
    if (existing && existing.promptId === prompt.promptId) return entry
    changed = true
    return { ...entry, activeInteractivePrompt: prompt }
  })
  return changed ? next : ides
}
