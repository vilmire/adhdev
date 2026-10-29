/**
 * Assistant verbs of the owner-decision inbox (structured-missions design
 * 2026-10-28 §5.2, §6.3, §6.4):
 *
 *   assistant_decision_answer   { project, answers[] | itemId+…, interpretedFrom }
 *   assistant_decision_request  { project, missionId?, question, options[], … }
 *
 * `decision_answer` records the OWNER's words as answers (`via: 'assistant'`).
 * Who may call it, strongest first:
 *   1. Only the assistant MCP server publishes the tool (coordinator / worker
 *      tool sets are untouched — their published counts are test-pinned).
 *   2. The daemon verb needs the bound assistant's MCP session credential
 *      (`mcpSessionCredential`, minted at assistant launch, never a coordinator
 *      or worker credential) AND the matching assistant session id.
 *   3. The assistant's CURRENT turn must have been opened by a human input
 *      (assistant input log): a turn started only by relays / notices cannot
 *      answer — "never answer without an owner utterance".
 *   4. `interpretedFrom` (the owner's words) is mandatory on every answer, and
 *      the record keeps it next to `via: 'assistant'`, so each answer is
 *      auditable and undoable.
 * A remote followed project's answer is relayed (`decision_answer` op) and
 * recorded on the host; the host's coordinator is notified by the existing
 * decision-delivery path.
 */
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { readRouterCommandIngress } from '../command-args.js';
import { verifyMcpSessionCredential } from '../mcp-command-ingress.js';
import type { CommandRouterResult } from '../router.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { ASSISTANT_TOOL_SOURCES, readAssistantSessionId } from './assistant-store.js';
import { assistantVerb, callRemote, fail, remoteBody, remoteFailure, resolveProject } from './assistant.js';
import { applyDecisionAnswers, parseDecisionAnswers, registerDecisionRequest } from './assistant-decisions-core.js';

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

/** The bound assistant session, proven by its own MCP session credential. Returns a refusal, or null. */
export function authorizeAssistantDecisionCaller(args: unknown, opts: { requireOwnerUtterance: boolean }): CommandRouterResult | null {
    const raw = (args && typeof args === 'object' && !Array.isArray(args)) ? args as Record<string, unknown> : {};
    const ingress = readRouterCommandIngress(raw);
    if (ingress && (ingress.source !== 'ipc' || ingress.inProcess || ingress.hasForgedProvenanceFields || ingress.hasRevokedOwnerProof)) {
        return fail('COMMAND_SOURCE_REJECTED', 'owner decisions are handled by the bound assistant session only');
    }
    if (raw.bind !== undefined || raw.token !== undefined) {
        return fail('COMMAND_SOURCE_REJECTED', 'worker credentials cannot use assistant decision verbs');
    }
    const boundSid = str(getAssistantRegistry().read()?.sessionId);
    const callerSid = readAssistantSessionId(raw);
    if (!boundSid || !callerSid || callerSid !== boundSid) {
        return fail('COMMAND_SOURCE_REJECTED', 'this verb requires the bound assistant session');
    }
    const scope = verifyMcpSessionCredential(raw.mcpSessionCredential);
    if (!scope || scope.isCoordinator || scope.sessionId !== boundSid) {
        return fail('COMMAND_SOURCE_REJECTED', 'this verb requires the bound assistant session credential');
    }
    if (opts.requireOwnerUtterance) {
        const log = getAssistantServices().inputLog;
        const turn = log.currentTurn(boundSid);
        // `human_unverified` = the owner's dashboard chat on a daemon with no owner
        // authentication (standalone default). Accepting it HERE adds no authority:
        // on such a daemon any local process can already answer as the owner via
        // `mission_decision_answer` over ipc / `adhdev decide`. Owner actions and
        // store writes never accept it (classifyWriteOrigin ignores that kind).
        const humanTurn = !!turn && turn.open && (turn.openedBy === 'human' || turn.openedBy === 'human_unverified');
        if (!humanTurn && log.writeContext(boundSid).origin !== 'human' && !isUnverifiedHumanWrite(boundSid)) {
            return fail(
                'no_owner_utterance',
                'No owner message is behind this call: decisions are answered only on the owner\'s own words in the current turn. Ask the owner, then answer when they reply.',
            );
        }
    }
    return null;
}

/** The most recent delivered input is an unverified dashboard human (the equivalent of writeContext origin `human`). */
function isUnverifiedHumanWrite(sessionId: string): boolean {
    const entries = getAssistantServices().inputLog.entries(sessionId);
    return entries[entries.length - 1]?.source === 'human_unverified';
}

const decisionAnswer = assistantVerb(ASSISTANT_VERB.decisionAnswer, async (ports, args, ctx) => {
    const denied = authorizeAssistantDecisionCaller(args, { requireOwnerUtterance: true });
    if (denied) return denied;
    const answers = parseDecisionAnswers(args);
    if (typeof answers === 'string') return fail('invalid_args', answers);
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    let body: Record<string, unknown>;
    if (p.remote) {
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'decision_answer', { answers });
        if (!out.ok) return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
        body = { ...remoteBody(out), host: p.remote.label, via: 'relay' };
    } else {
        const done = await applyDecisionAnswers(ctx, meshId, answers);
        body = { ...done, host: 'this machine' };
    }
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const allOk = body.allOk !== false;
    return {
        success: allOk,
        ...(allOk ? {} : { code: 'decision_answer_failed', error: 'one or more answers were not recorded — see answers[]' }),
        project: p.slug,
        meshId,
        lines,
        result: body,
    };
});

const decisionRequest = assistantVerb(ASSISTANT_VERB.decisionRequest, async (ports, args) => {
    const denied = authorizeAssistantDecisionCaller(args, { requireOwnerUtterance: false });
    if (denied) return denied;
    if (!str(args.question)) return fail('invalid_args', 'question is required');
    const p = await resolveProject(ports, args.project);
    if (!p.ok) return p.result;
    const meshId = p.mesh.id;
    const payload = {
        question: args.question, options: args.options, context: args.context, missionId: args.missionId,
        recommended: args.recommended, urgency: args.urgency, dueAt: args.dueAt, onDue: args.onDue, allowFreeText: args.allowFreeText,
    };
    if (p.remote) {
        const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
        const out = await callRemote(ports, { ...p, remote: p.remote }, 'decision_request', clean);
        if (!out.ok) return remoteFailure({ project: p.slug, meshId }, p.remote, out, ports, p.followedRemote);
        const body = remoteBody(out);
        return body.success === false
            ? fail(str(body.code) || 'decision_rejected', str(body.error) || 'decision_rejected', { project: p.slug, meshId })
            : { success: true, project: p.slug, meshId, result: { ...body, host: p.remote.label, via: 'relay' } };
    }
    const done = registerDecisionRequest(meshId, payload as Record<string, unknown>);
    if (done.success !== true) return fail(str(done.code) || 'decision_rejected', str(done.error) || 'decision_rejected', { project: p.slug, meshId });
    return { success: true, project: p.slug, meshId, result: done };
});

export const assistantDecisionHandlers = {
    [ASSISTANT_VERB.decisionAnswer]: decisionAnswer,
    [ASSISTANT_VERB.decisionRequest]: decisionRequest,
};

export const assistantDecisionSpecs = defineCommandSpecs('high', assistantDecisionHandlers, {
    [ASSISTANT_VERB.decisionAnswer]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.decisionRequest]: { sources: [...ASSISTANT_TOOL_SOURCES] },
});
