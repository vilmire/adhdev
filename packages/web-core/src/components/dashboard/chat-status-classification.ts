/**
 * Status classification for the session chat controller.
 *
 * Pure, dependency-free predicates over a session's status string and the
 * status-lane event vocabulary. The two predicates are deliberately NOT
 * interchangeable; read each declaration before substituting one for the other.
 */

import {
  SESSION_STATUS_ALIASES,
  isBusyStatus,
  isWorkingStatus,
  statusesOfClass,
} from '@adhdev/mesh-shared'

/**
 * Statuses that keep a session warm/active: every spelling of class `working`
 * or `blocked` (i.e. `isBusyStatus`). Crucially includes `waiting_approval` and
 * `waiting_choice`, which `isBusyChatStatus` excludes. Derived from the one
 * status vocabulary; kept as a Set for the `.has()` call in the warm-controller
 * selection.
 */
export const WARM_SESSION_CHAT_ACTIVE_STATUSES: ReadonlySet<string> = new Set<string>([
  ...statusesOfClass('working'),
  ...statusesOfClass('blocked'),
  ...Object.keys(SESSION_STATUS_ALIASES).filter((alias) => isBusyStatus(alias)),
])

/**
 * "The agent is still producing" — class `working` only. A session parked on
 * an approval or a question picker is NOT busy in this sense.
 */
export function isBusyChatStatus(status: unknown): boolean {
  return isWorkingStatus(status)
}

/**
 * Status-lane events that mean the agent has STOPPED producing for now:
 *
 *  - `agent:generating_completed` / `agent:stopped` — the turn is over.
 *  - `agent:waiting_approval` / `agent:waiting_choice` — the agent is parked on
 *    a human decision.
 *
 * The chat controller uses these as out-of-band evidence against the keyed
 * chat lane: if the lane's last committed view still says the agent is
 * producing when one of these arrives, the lane missed a frame and the
 * controller asks the owner for one base frame (`request_transcript_base`).
 * `agent:generating_started` and the monitor:* events are absent — they
 * describe a session that is still nominally producing, which is no
 * contradiction at all.
 */
const TERMINAL_STATUS_EVENTS = new Set([
  'agent:generating_completed',
  'agent:stopped',
  'agent:waiting_approval',
  'agent:waiting_choice',
])

export function isTerminalChatStatusEvent(event: unknown): boolean {
  return typeof event === 'string' && TERMINAL_STATUS_EVENTS.has(event)
}
