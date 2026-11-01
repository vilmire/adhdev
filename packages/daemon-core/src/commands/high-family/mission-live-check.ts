/**
 * mission_live_check_resolve { meshId, itemId, verdict: 'works'|'doesnt_work', note?, via? }
 *
 * Owner-only, same authority model as `mission_decision_answer` (see mission-decisions.ts): the
 * caller is classified from the router-stamped source and the router-recorded MCP capability, never
 * from payload fields. No MCP tool exposes this command; coordinator / worker credentials are
 * refused; the assistant label is not accepted (a live check is the owner's own observation).
 */
import { defineCommandSpecs } from '../command-registry.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import type { HighFamilyHandler } from './types.js';
import { classifyDecisionCaller, MISSION_DECISION_ANSWER_SOURCES } from './mission-decisions.js';
import { isLiveCheckVerdict, resolveLiveCheck, type LiveCheckVia } from '../../mesh/mesh-mission-live-check.js';

export const MISSION_LIVE_CHECK_RESOLVE = 'mission_live_check_resolve';

const resolve: HighFamilyHandler = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyDecisionCaller(raw, MISSION_LIVE_CHECK_RESOLVE);
    if (!caller.ok) return { success: false, code: 'live_check_resolve_not_allowed', error: caller.error };
    if (caller.actor.via === 'assistant') {
        return { success: false, code: 'live_check_resolve_not_allowed', error: 'only the owner can record a live check result' };
    }
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = typeof args.meshId === 'string' ? args.meshId.trim() : '';
    const itemId = typeof args.itemId === 'string' ? args.itemId.trim() : '';
    if (!meshId || !itemId) return { success: false, code: 'invalid_args', error: 'meshId and itemId are required' };
    if (!isLiveCheckVerdict(args.verdict)) return { success: false, code: 'invalid_args', error: "verdict must be 'works' or 'doesnt_work'" };
    const result = resolveLiveCheck(
        { meshId, itemId, verdict: args.verdict, ...(typeof args.note === 'string' ? { note: args.note } : {}) },
        { via: caller.actor.via as LiveCheckVia },
    );
    if (!result.ok) return { success: false, code: result.code, error: result.error };
    return { success: true, meshId: result.meshId, missionId: result.missionId, itemId: result.itemId, state: result.state, ...(result.evidenceItemId ? { evidenceItemId: result.evidenceItemId } : {}) };
};

export const missionLiveCheckSpecs = defineCommandSpecs('high', {
    [MISSION_LIVE_CHECK_RESOLVE]: resolve,
}, {
    [MISSION_LIVE_CHECK_RESOLVE]: { sources: [...MISSION_DECISION_ANSWER_SOURCES] },
});
