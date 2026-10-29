/**
 * Owner-decision push → one-tap answer (structured missions design §6.3 / §9, bundle F).
 *
 * The service worker (`packages/web-cloud/public/sw.js`) posts `{ type: 'notification_action',
 * action: 'decision_choose', meshId, itemId, optionId, daemonId, url }` to an open dashboard
 * window when the user taps the recommended-option action. That window answers over the normal
 * dashboard command path (P2P only — the server never relays answers) with `via: 'push'`.
 * If the command fails for any reason the user is sent to the `/needs-you` deep link instead,
 * where the card has the option preselected (one confirm tap).
 */
export const DECISION_CHOOSE_ACTION = 'decision_choose'

export interface DecisionPushActionMessage {
    type?: unknown
    action?: unknown
    meshId?: unknown
    itemId?: unknown
    optionId?: unknown
    daemonId?: unknown
    url?: unknown
}

export interface DecisionPushAnswerPlan {
    routeId: string
    payload: { meshId: string; itemId: string; optionId: string; via: 'push' }
    fallbackUrl: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function buildDecisionFallbackUrl(meshId: string, itemId: string, optionId?: string): string {
    const params = new URLSearchParams({ mesh: meshId, decision: itemId })
    if (optionId) params.set('choose', optionId)
    return `/needs-you?${params.toString()}`
}

/** Pure: a plan for a decision-choose message, or null for anything else / incomplete. */
export function planDecisionPushAnswer(data: DecisionPushActionMessage | null | undefined): DecisionPushAnswerPlan | null {
    if (!data || data.type !== 'notification_action' || data.action !== DECISION_CHOOSE_ACTION) return null
    const meshId = str(data.meshId)
    const itemId = str(data.itemId)
    const optionId = str(data.optionId)
    const routeId = str(data.daemonId)
    if (!meshId || !itemId || !optionId || !routeId) return null
    return {
        routeId,
        payload: { meshId, itemId, optionId, via: 'push' },
        fallbackUrl: buildDecisionFallbackUrl(meshId, itemId, optionId),
    }
}

/** True when a daemon command reply means the answer was NOT recorded. */
export function decisionAnswerFailed(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false
    const r = result as { success?: unknown; ok?: unknown; error?: unknown }
    return r.success === false || r.ok === false || (typeof r.error === 'string' && r.error.length > 0)
}
