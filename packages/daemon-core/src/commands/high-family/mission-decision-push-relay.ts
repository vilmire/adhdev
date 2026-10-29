/**
 * Server-relayed push-notification decision answer (mission 4ae3edf2, owner 2026-10-29).
 *
 * The owner opted in ("answer decisions from the notification without opening the app") and tapped
 * the recommended-option action on a push with no dashboard window open. The service worker posted a
 * single-use answer token to the server; the server validated it (user, daemon, expiry, single use)
 * and forwarded `{ meshId, itemId, optionId }` — nothing else — over the daemon WS.
 *
 * ★Ingress rules (the answer is an OWNER answer, so the door must be narrow):
 *  - `sources: ['push_relay']` — a source only the server's relay frame carries. The cloud transport
 *    maps `push_relay` to `ws` for every other command, and REST/API callers are stamped `api` by the
 *    server, so no agent, worker, MCP credential, P2P peer or API caller can reach this handler.
 *    The ordinary `mission_decision_answer` stays closed to `ws`/`push_relay` (see mission-decisions.ts).
 *  - Exactly the three id fields; anything else (free text, `via`, credentials) is refused.
 *  - Only the decision's RECOMMENDED option, and only while the decision is still open — a relayed tap
 *    never overwrites an answer the owner already gave elsewhere.
 *  - Provenance: the answer is recorded `by: owner, via: 'push', ingress: 'push_relay'`, and the
 *    mission event carries the same, so the transcript/audit shows it was relayed through the server.
 *
 * Trade-off (owner principle: convenience first, never silently): this trusts the server (and the
 * Cloudflare account behind it) to forward only genuine, token-authorized taps. A compromised server
 * could answer open decisions with their recommended option — it cannot pick any other option, read
 * the question, or answer an already-answered decision.
 */
import { DECISION_PUSH_RELAY_COMMAND, DECISION_PUSH_RELAY_SOURCE } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { COMMAND_SOURCE_ARG } from '../command-args.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import { buildOwnerDecisions } from '../../mesh/mesh-mission-decisions.js';
import { answerAndDeliver } from './mission-decisions.js';
import type { HighFamilyHandler } from './types.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ALLOWED_KEYS = new Set(['meshId', 'itemId', 'optionId']);

function refuse(code: string, error: string) {
    return { success: false, code, error };
}

const relayAnswer: HighFamilyHandler = async (ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    // Belt and braces on top of `sources`: the router-stamped source must be the relay's.
    if (raw[COMMAND_SOURCE_ARG] !== DECISION_PUSH_RELAY_SOURCE) {
        return refuse('decision_answer_not_allowed', 'only the server push relay may use this command');
    }
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    // Strict: unknown keys (free text, via, credentials …) are refused, not ignored.
    const extra = Object.keys(args).filter(k => !ALLOWED_KEYS.has(k) && !k.startsWith('_'));
    if (extra.length > 0) return refuse('invalid_args', 'unexpected fields');
    const { meshId, itemId, optionId } = args;
    if (![meshId, itemId, optionId].every(v => typeof v === 'string' && ID_RE.test(v))) {
        return refuse('invalid_args', 'meshId, itemId and optionId are required ids');
    }
    const entry = buildOwnerDecisions(meshId as string).find(e => e.itemId === itemId);
    if (!entry) return refuse('decision_not_open', 'this decision is no longer open');
    if (entry.recommended !== optionId) return refuse('option_not_relayable', 'only the recommended option can be answered from a notification');
    return answerAndDeliver(ctx, { meshId: meshId as string, itemId: itemId as string, optionId: optionId as string },
        { by: 'owner', via: 'push', ingress: DECISION_PUSH_RELAY_SOURCE });
};

export const missionDecisionPushRelaySpecs = defineCommandSpecs('high', {
    [DECISION_PUSH_RELAY_COMMAND]: relayAnswer,
}, {
    [DECISION_PUSH_RELAY_COMMAND]: { sources: [DECISION_PUSH_RELAY_SOURCE] },
});
