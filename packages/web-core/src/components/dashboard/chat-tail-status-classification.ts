/**
 * Status classification for the chat-tail controller.
 *
 * Pure, dependency-free predicates over a session's status string and the
 * status-lane event vocabulary. Extracted from `session-chat-tail-controller.ts`
 * as a barrel-preserving pure move (no behaviour change) when that file crossed
 * the `check:file-sizes` threshold — the controller re-exports
 * `isTerminalChatTailStatusEvent` so `src/index.ts` and every existing importer
 * keep their current path.
 *
 * The three predicates here are deliberately NOT interchangeable; each encodes a
 * different safety argument, documented on its own declaration. Read those before
 * substituting one for another.
 */

/**
 * Statuses that keep a session warm/active. Crucially includes
 * `waiting_approval`, which `isBusyChatTailStatus` excludes.
 */
export const WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES = new Set([
  'generating',
  'waiting_approval',
  'starting',
  'streaming',
  'working',
])

export function isBusyChatTailStatus(status: unknown): boolean {
  const value = typeof status === 'string' ? status.toLowerCase() : ''
  return value === 'generating' || value === 'no_progress' || value === 'long_generating' || value === 'streaming' || value === 'working' || value === 'starting'
}

/**
 * (D1) Status-lane events that mean the agent has STOPPED producing for now.
 *
 * These are the only events allowed to bypass the `replicaHealthy` refusal in
 * `shouldRefreshForLiveness`, so the membership of this set is the safety
 * argument, not a convenience list:
 *
 *  - `agent:generating_completed` / `agent:stopped` — the turn is over.
 *  - `agent:waiting_approval` / `agent:waiting_choice` — the agent is parked on
 *    a human decision. It is not generating, and this is precisely the moment
 *    the user needs the tail (the modal text is the thing being decided).
 *
 * `agent:generating_started` is deliberately ABSENT: mid-generation is exactly
 * the window where a legacy `read_chat` can land behind a newer replica
 * revision, which is the last-writer-wins hazard the veto exists for. The
 * monitor:* events are absent for the same reason — `no_progress` /
 * `long_generating` describe a session that is still nominally generating.
 */
const TERMINAL_STATUS_EVENTS = new Set([
  'agent:generating_completed',
  'agent:stopped',
  'agent:waiting_approval',
  'agent:waiting_choice',
])

export function isTerminalChatTailStatusEvent(event: unknown): boolean {
  return typeof event === 'string' && TERMINAL_STATUS_EVENTS.has(event)
}

/**
 * Shrink-defer gate (NOT a "busy" predicate). Returns true for every status that
 * keeps a session warm/active, i.e. every member of
 * WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES, which crucially includes
 * `waiting_approval`.
 *
 * `isBusyChatTailStatus` intentionally EXCLUDES `waiting_approval` (and other
 * warm states like `starting`) because its callers rely on the strict "busy"
 * meaning. But the chat-tail shrink-defense must protect the approval window
 * too: during `waiting_approval` the daemon can emit a short partial tail (e.g.
 * only the user prompt, assistant bubble briefly missing) that — without this
 * guard — replaces the longer hydrated `liveMessages` and makes the assistant
 * bubble transiently disappear/return (CHATFLICKER on approve). We widen ONLY
 * this shrink-defer gate to WARM_ACTIVE membership; `isBusyChatTailStatus` keeps
 * its existing busy semantics untouched.
 */
export function shouldGuardTailShrinkForStatus(status: unknown): boolean {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES.has(value)
}
