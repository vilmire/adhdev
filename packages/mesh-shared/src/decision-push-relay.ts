/**
 * Opt-in "answer a decision from the push notification" relay (mission 4ae3edf2, owner 2026-10-29).
 *
 * ★ A deliberate, narrow exception to "no dashboard command relay over server WS" (CLAUDE.md).
 * With the user's opt-in setting ON and no dashboard window open, the notification's
 * recommended-option action is POSTed by the service worker to the server, which forwards it to the
 * owning daemon over the existing daemon WS as ONE fixed command. What crosses the server is exactly
 * `{ meshId, itemId, optionId }` (+ the single-use answer token that authorizes it) — never the
 * question, context or free text. Shared so the server's frame and the daemon's ingress cannot drift.
 */

/** Daemon command the server sends; its only accepted source is {@link DECISION_PUSH_RELAY_SOURCE}. */
export const DECISION_PUSH_RELAY_COMMAND = 'mission_decision_push_relay_answer'

/** Command source the server stamps on the relayed frame (never settable by REST/API callers). */
export const DECISION_PUSH_RELAY_SOURCE = 'push_relay'

/** The complete relayed payload — ids only. */
export type DecisionPushRelayPayload = {
    meshId: string
    itemId: string
    optionId: string
}
