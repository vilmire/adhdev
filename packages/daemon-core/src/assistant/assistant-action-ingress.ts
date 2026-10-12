import { assistantExecution, parseAssistantAction, type AssistantAction, type ExecutionState } from './assistant-execution.js';
import { getAssistantRegistry } from './assistant-registry.js';
import { getAssistantServices } from './assistant-services.js';
import { isNegativeApprovalLabel } from '../providers/approval-utils.js';

interface Instance { getState?(): any }
interface Adapter { getStatus?(): any }
export interface ActionComponents {
    instanceManager?: { getInstance(id: string): Instance | undefined | null };
    cliManager?: { adapters: Map<string, Adapter> };
}
export function assistantExecutionState(components: ActionComponents): ExecutionState {
    const entry = getAssistantRegistry().reload();
    const sid = entry?.sessionId ?? null;
    const runtime = sid ? components.instanceManager?.getInstance(sid) ?? null : null;
    const adapter = sid ? components.cliManager?.adapters.get(sid) ?? null : null;
    const state = runtime?.getState?.();
    return { sessionId: sid, enabled: entry?.executionEnabled !== false, runtime, adapter,
        policyRevision: entry?.executionRevision ?? 0, provider: state?.type ?? '', assistant: state?.settings?.assistant === true };
}
export function actionTarget(components: ActionComponents, action: AssistantAction) {
    const state = components.instanceManager?.getInstance(action.targetSessionId)?.getState?.();
    const settings = state?.settings;
    const meshId = settings?.meshNodeFor || settings?.meshCoordinatorFor;
    if (meshId !== action.meshId || !getAssistantServices().listMeshes().some(m => m.id === meshId)) return null;
    const adapter = components.cliManager?.adapters.get(action.targetSessionId);
    const status = adapter?.getStatus?.();
    const modal = status?.activeModal ?? state?.activeChat?.activeModal;
    if (!modal || !Array.isArray(modal.buttons) || !modal.buttons.includes(action.button)
        || status?.activeInteractivePrompt || state?.activeChat?.activeInteractivePrompt) return null;
    if (isNegativeApprovalLabel(action.button) !== (action.action === 'reject')) return null;
    return { modal, buttonIndex: modal.buttons.indexOf(action.button) };
}

/** Explicit directive in authenticated dashboard CHAT only. Raw PTY provenance is insufficient. */
export function prepareOwnerActionChat(components: ActionComponents, source: unknown, sessionId: string, text: string) {
    if (!text.startsWith('/assistant-action ')) return { success: true as const, text };
    const state = assistantExecutionState(components);
    if (sessionId !== state.sessionId || !['p2p', 'ws', 'standalone'].includes(String(source))) return { success: true as const, text };
    let raw: unknown;
    try { raw = JSON.parse(text.slice('/assistant-action '.length)); } catch { return { success: false as const, code: 'invalid_assistant_action' }; }
    const action = parseAssistantAction(raw);
    if (!action) return { success: false as const, code: 'invalid_assistant_action' };
    const target = actionTarget(components, action);
    if (!target) return { success: false as const, code: 'assistant_action_target_unavailable' };
    const issued = assistantExecution.issue(source, state, action, target.modal);
    if (!issued.success) return issued;
    return { success: true as const, text: `${text}\n[ADHDev owner action] ${JSON.stringify({ ...action, authorization: issued.authorization, expiresAt: issued.expiresAt })}` };
}
