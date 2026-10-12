import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { assistantToolGate, ASSISTANT_TOOL_SOURCES, readAssistantSessionId } from './assistant-store.js';
import { assistantExecution, parseAssistantAction, createAssistantExecutionGuard } from '../../assistant/assistant-execution.js';
import { actionTarget, assistantExecutionState } from '../../assistant/assistant-action-ingress.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import type { HighFamilyHandler } from './types.js';

const state: HighFamilyHandler = async (ctx, args) => {
    const s = assistantExecutionState(ctx.components());
    return { success: true, executionEnabled: s.enabled,
        executionAvailable: readAssistantSessionId(args) === s.sessionId && assistantExecution.available(s) };
};
const settings: HighFamilyHandler = async (_ctx, args) => {
    if (typeof args?.enabled !== 'boolean') return { success: false, code: 'invalid_args', error: 'enabled boolean required' };
    const entry = getAssistantRegistry().updateSettings({ executionEnabled: args.enabled });
    return { success: !!entry, executionEnabled: entry?.executionEnabled !== false };
};
const action: HighFamilyHandler = async (ctx, args) => {
    const gate = assistantToolGate(ASSISTANT_VERB.action, args); if (gate) return gate;
    const parsed = parseAssistantAction({ meshId: args?.meshId, targetSessionId: args?.targetSessionId, action: args?.action, button: args?.button });
    if (!parsed || args?.promptSource !== undefined || args?.consent !== undefined) return { success: false, code: 'invalid_args' };
    const s = assistantExecutionState(ctx.components());
    if (readAssistantSessionId(args) !== s.sessionId) return { success: false, code: 'assistant_session_required' };
    const target = actionTarget(ctx.components(), parsed);
    if (!target) return { success: false, code: 'assistant_action_target_unavailable' };
    const consent = assistantExecution.consume(args.authorization, s, parsed, target.modal);
    if (!consent.success) return consent;
    // Existing approval machinery, with an exact-modal guard at its last synchronous dispatch point.
    return ctx.execute('resolve_action', { targetSessionId: parsed.targetSessionId, action: parsed.action,
        button: parsed.button, buttonIndex: target.buttonIndex, expectedModalIdentity: consent.expectedModalIdentity, assistantExecutionGuard: createAssistantExecutionGuard(() => Date.now() < consent.expiresAt && assistantExecutionState(ctx.components()).policyRevision === s.policyRevision && assistantExecution.available(assistantExecutionState(ctx.components()))) }, 'internal', { inProcess: true });
};
export const assistantActionSpecs = defineCommandSpecs('high', {
    [ASSISTANT_VERB.action]: action, [ASSISTANT_VERB.executionState]: state, [ASSISTANT_VERB.executionSettings]: settings,
}, {
    [ASSISTANT_VERB.action]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.executionState]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.executionSettings]: { sources: ['p2p', 'ws', 'standalone'] },
});
