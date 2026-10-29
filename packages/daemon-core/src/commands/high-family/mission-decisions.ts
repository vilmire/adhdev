/**
 * Owner-decision commands (structured-missions design 2026-10-28 §6):
 *
 *   mission_decisions_list   { meshId?, includeAnswered?, includeLiveChecks?, includeMissions? }  → the `ownerDecisions` projection (+ `liveChecks` / per-mission structure on request)
 *   mission_decision_answer  { meshId, itemId, optionId?, text?, via?, interpretedFrom?, undo? }
 *
 * ★The one hard rule (design §6.3/§9): a coordinator or worker credential can
 * never answer. Enforcement, strongest first:
 *   1. No MCP tool exposes this command to the coordinator / worker tool sets
 *      (the published mesh tool count is test-pinned and unchanged).
 *   2. `sources` excludes `mesh`/`internal`/`project_attach`/`ws`/`api` — the
 *      daemon↔daemon relay and in-process callers can never reach the handler.
 *   3. `ipc` (the local MCP/CLI socket — the cloud daemon and standalone both
 *      stamp every local-socket frame `ipc`) is accepted only when NO MCP
 *      credential is behind the call: the router records any presented session
 *      credential (`MCP_ATTRIBUTED_COMMANDS`) and any worker credential (denied
 *      capability); a coordinator, a worker, or a revoked/unknown credential is
 *      refused here with `decision_answer_not_allowed`. The assistant (bound
 *      session, not a coordinator) is the only MCP-origin caller let through and
 *      must state `via: 'assistant'` + the owner's words (`interpretedFrom`).
 *   4. Owner transports (`p2p` dashboard, `standalone` authenticated dashboard)
 *      may state `dashboard` | `push`; a credential-less local call (the CLI, or a
 *      standalone dashboard without a password, which is demoted to `ipc`) may state
 *      `cli` | `dashboard` | `push`. `assistant` is never accepted from them.
 *
 * Residual (not detectable by the daemon): a coordinator's own shell running
 * `adhdev decide` is indistinguishable from the owner's terminal. The CLI
 * refuses when it detects a daemon-launched agent session environment, and
 * every answer carries `via`/`by` plus a mission event, so it is auditable.
 */
import { defineCommandSpecs } from '../command-registry.js';
import { COMMAND_SOURCE_ARG } from '../command-args.js';
import { readAuthenticatedMcpCommand, readAuthenticatedMcpScope } from '../mcp-command-ingress.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { projectPortsFor } from './assistant-store.js';
import type { HighFamilyHandler } from './types.js';
import {
    answerMissionDecision,
    buildMissionStructure,
    buildOpenLiveChecks,
    buildOwnerDecisions,
    listRecentlyAnswered,
    type DecisionActor,
    type DecisionAnswerRequest,
    type DecisionAnswerVia,
} from '../../mesh/mesh-mission-decisions.js';
import { createCoordinatorDecisionSender, deliverDecisionAnswer } from '../../mesh/mesh-mission-decision-delivery.js';
import { hostedMeshes } from '../../mesh/mesh-housekeeping-tick.js';
import { LOG } from '../../logging/logger.js';

export const MISSION_DECISION_ANSWER = 'mission_decision_answer';
export const MISSION_DECISIONS_LIST = 'mission_decisions_list';

/** Transports that can carry an owner (or a credential-checked assistant). */
export const MISSION_DECISION_ANSWER_SOURCES = ['p2p', 'standalone', 'ext', 'ipc'] as const;
export const MISSION_DECISIONS_LIST_SOURCES = ['p2p', 'standalone', 'ext', 'ipc'] as const;

const RECENT_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export type DecisionCaller =
    | { ok: true; actor: DecisionActor }
    | { ok: false; code: 'decision_answer_not_allowed'; error: string };

function refuse(error: string): DecisionCaller {
    return { ok: false, code: 'decision_answer_not_allowed', error };
}

/**
 * Who is calling, from the ROUTER-stamped source and the router-recorded MCP
 * capability — never from payload fields. Exported for tests.
 */
export function classifyDecisionCaller(rawArgs: Record<string, unknown>): DecisionCaller {
    const source = str(rawArgs[COMMAND_SOURCE_ARG]);
    const requestedVia = str(rawArgs.via);
    if (rawArgs.bind !== undefined || rawArgs.token !== undefined || rawArgs.mcpSessionCredential !== undefined) {
        return refuse('worker/session credentials cannot answer owner decisions');
    }
    const mcp = readAuthenticatedMcpCommand(rawArgs, MISSION_DECISION_ANSWER);
    if (mcp.present) {
        const scope = mcp.valid ? readAuthenticatedMcpScope(rawArgs, MISSION_DECISION_ANSWER) : null;
        const assistantSid = str(getAssistantRegistry().read()?.sessionId);
        if (scope && !scope.isCoordinator && scope.sessionId && assistantSid && scope.sessionId === assistantSid) {
            if (requestedVia && requestedVia !== 'assistant') return refuse(`assistant callers must use via 'assistant'`);
            return { ok: true, actor: { by: 'owner', via: 'assistant' } };
        }
        return refuse('coordinator and worker credentials cannot answer owner decisions — only the owner (or the assistant on the owner\'s words) can');
    }
    if (source === 'ipc') {
        // No MCP credential behind a local call: the owner's CLI, or a standalone dashboard
        // with no password configured (its commands are demoted to `ipc`). Only the assistant
        // label needs a credential.
        const via = (requestedVia || 'cli') as DecisionAnswerVia;
        if (via !== 'cli' && via !== 'dashboard' && via !== 'push') return refuse(`via '${requestedVia}' needs an assistant session credential`);
        return { ok: true, actor: { by: 'owner', via } };
    }
    if (source === 'p2p' || source === 'standalone' || source === 'ext') {
        const via = (requestedVia || 'dashboard') as DecisionAnswerVia;
        if (via !== 'dashboard' && via !== 'push') return refuse(`via '${requestedVia}' is not accepted from the ${source} transport`);
        return { ok: true, actor: { by: 'owner', via } };
    }
    return refuse(`source '${source || 'unknown'}' cannot answer owner decisions`);
}

const answer: HighFamilyHandler = async (ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyDecisionCaller(raw);
    if (!caller.ok) return { success: false, code: caller.code, error: caller.error };
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    const meshId = str(args.meshId);
    const itemId = str(args.itemId);
    if (!meshId || !itemId) return { success: false, code: 'invalid_args', error: 'meshId and itemId are required' };
    return answerAndDeliver(ctx, {
        meshId,
        itemId,
        ...(str(args.missionId) ? { missionId: str(args.missionId) } : {}),
        ...(typeof args.optionId === 'string' ? { optionId: args.optionId } : {}),
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        ...(typeof args.interpretedFrom === 'string' ? { interpretedFrom: args.interpretedFrom } : {}),
        ...(args.undo === true ? { undo: true } : {}),
    }, caller.actor);
};

/** Record the answer, then try the immediate coordinator delivery. Shared with the push-relay ingress. */
export async function answerAndDeliver(
    ctx: Parameters<HighFamilyHandler>[0],
    req: DecisionAnswerRequest,
    actor: DecisionActor,
): ReturnType<HighFamilyHandler> {
    const { meshId, itemId } = req;
    const result = answerMissionDecision(req, actor);
    if (!result.ok) {
        return { success: false, code: result.code, error: result.error, ...(result.validOptions ? { validOptions: result.validOptions } : {}) };
    }
    let deliveryState: string | undefined = result.delivery?.state;
    if (result.delivery) {
        try {
            const sender = createCoordinatorDecisionSender(() => projectPortsFor(ctx));
            const attempt = await deliverDecisionAnswer(meshId, itemId, sender);
            if (attempt === 'sent' || attempt === 'duplicate') deliveryState = 'sent';
            else if (attempt === 'queued') deliveryState = 'queued';
        } catch (e: any) {
            // The write is committed and the delivery stays pending — the housekeeping tick retries.
            LOG.warn('MissionDecision', `immediate delivery of ${itemId} failed, left pending: ${e?.message || e}`);
        }
    }
    return {
        success: true,
        action: result.action,
        meshId: result.meshId,
        missionId: result.missionId,
        itemId: result.itemId,
        revision: result.revision,
        ...(result.answer ? { answer: result.answer } : {}),
        ...(deliveryState ? { delivery: deliveryState } : {}),
    };
}

const list: HighFamilyHandler = async (ctx, rawArgs) => {
    const args = stripRouterInternalArgs((rawArgs ?? {}) as Record<string, unknown>);
    const wanted = str(args.meshId);
    let meshIds: string[];
    const meshNames: Record<string, string> = {};
    try {
        const hosted = hostedMeshes(ctx.components());
        for (const h of hosted) if (typeof h.mesh.name === 'string' && h.mesh.name) meshNames[h.mesh.id] = h.mesh.name;
        meshIds = wanted ? [wanted] : hosted.map(h => h.mesh.id);
    } catch { meshIds = wanted ? [wanted] : []; }
    const decisions = meshIds.flatMap(id => buildOwnerDecisions(id));
    const recentlyAnswered = args.includeAnswered === true
        ? meshIds.flatMap(id => listRecentlyAnswered(id, Date.now() - RECENT_ANSWER_WINDOW_MS))
        : undefined;
    // Opt-in: the default output stays exactly as before.
    const liveChecks = args.includeLiveChecks === true ? meshIds.flatMap(id => buildOpenLiveChecks(id)) : undefined;
    const missions = args.includeMissions === true ? meshIds.flatMap(id => buildMissionStructure(id)) : undefined;
    return {
        success: true,
        ownerDecisions: decisions,
        ...(missions ? { missions, hostedMeshIds: meshIds, meshNames } : {}),
        ...(recentlyAnswered ? { recentlyAnswered } : {}),
        ...(liveChecks ? { liveChecks } : {}),
    };
};

export const missionDecisionSpecs = defineCommandSpecs('high', {
    [MISSION_DECISION_ANSWER]: answer,
    [MISSION_DECISIONS_LIST]: list,
}, {
    [MISSION_DECISION_ANSWER]: { sources: [...MISSION_DECISION_ANSWER_SOURCES] },
    [MISSION_DECISIONS_LIST]: { sources: [...MISSION_DECISIONS_LIST_SOURCES] },
});
