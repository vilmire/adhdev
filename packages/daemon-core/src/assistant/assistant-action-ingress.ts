import { assistantExecution, modalIdentity, parseAssistantAction, type AssistantAction, type ExecutionState } from './assistant-execution.js';
import { getAssistantRegistry } from './assistant-registry.js';
import { getAssistantServices } from './assistant-services.js';
import { isNegativeApprovalLabel } from '../providers/approval-utils.js';

interface Instance { getState?(): any }
interface Adapter { getStatus?(): any }
export interface ActionComponents {
    instanceManager?: { getInstance(id: string): Instance | undefined | null };
    sessionRegistry?: { get(id: string): { transport?: string } | undefined };
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
    if (!adapter || state?.category !== 'cli' || components.sessionRegistry?.get(action.targetSessionId)?.transport !== 'pty') return null;
    const status = adapter.getStatus?.();
    const modal = status?.activeModal ?? state?.activeChat?.activeModal;
    if (!modal || !Array.isArray(modal.buttons) || !modal.buttons.includes(action.button)
        || status?.activeInteractivePrompt || state?.activeChat?.activeInteractivePrompt) return null;
    if (isNegativeApprovalLabel(action.button) !== (action.action === 'reject')) return null;
    return { modal, buttonIndex: modal.buttons.indexOf(action.button) };
}

/** Read-only choices from actual live local PTY modals. Display text supplies no authority. */
export function ownerActionChoices(components: ActionComponents) {
    const choices: Array<AssistantAction & { modalIdentity: string; label: string; message: string }> = [];
    for (const sid of components.cliManager?.adapters.keys() ?? []) {
        const st = components.instanceManager?.getInstance(sid)?.getState?.();
        const meshId = st?.settings?.meshNodeFor || st?.settings?.meshCoordinatorFor;
        const modal = components.cliManager?.adapters.get(sid)?.getStatus?.()?.activeModal ?? st?.activeChat?.activeModal;
        for (const button of Array.isArray(modal?.buttons) ? modal.buttons.slice(0, 16) : []) {
            const action = parseAssistantAction({ meshId, targetSessionId: sid, button, action: isNegativeApprovalLabel(button) ? 'reject' : 'approve' });
            if (!action || !actionTarget(components, action)) continue;
            choices.push({ ...action, modalIdentity: modalIdentity(modal), label: String(st?.settings?.meshNodeId || sid).slice(0, 200), message: String(modal.message ?? '').slice(0, 500) });
            if (choices.length >= 64) return choices;
        }
    }
    return choices;
}

/** Owner CHAT only: bounded language or an explicit UI choice, never provider-generated consent. */
export function prepareOwnerActionChat(components: ActionComponents, source: unknown, sessionId: string, text: string,
    selection?: unknown, expectedModal?: unknown) {
    const state = assistantExecutionState(components);
    if (sessionId !== state.sessionId || !['p2p', 'ws', 'standalone'].includes(String(source))) return { success: true as const, text };
    let raw: unknown = selection;
    if (selection === undefined && text.startsWith('/assistant-action ')) {
        try { raw = JSON.parse(text.slice('/assistant-action '.length)); } catch { return { success: false as const, code: 'invalid_assistant_action' }; }
    } else if (selection === undefined) {
        const direction = /^(?:please\s+)?(approve|reject)(?:\s+(?:the request for\s+)?(.+?))?[.!]?$/i.exec(text.trim());
        if (!direction) return { success: true as const, text };
        const requested = direction[1]!.toLowerCase();
        const targetName = direction[2]?.replace(/[.!]$/, '').trim();
        const choices = ownerActionChoices(components).filter(c => c.action === requested
            && (!targetName || ['this', 'selected permission'].includes(targetName.toLowerCase()) || c.label === targetName || c.targetSessionId === targetName));
        if (choices.length !== 1) return { success: false as const, code: 'assistant_action_needs_selection',
            error: 'Select the exact current permission and button in Assistant execution controls.', choices };
        const c = choices[0]!;
        raw = { meshId: c.meshId, targetSessionId: c.targetSessionId, action: c.action, button: c.button };
        expectedModal = c.modalIdentity;
    }
    const action = parseAssistantAction(raw);
    if (!action) return { success: false as const, code: 'invalid_assistant_action' };
    const target = actionTarget(components, action);
    if (!target) return { success: false as const, code: 'assistant_action_target_unavailable' };
    if (selection !== undefined && typeof expectedModal !== 'string') return { success: false as const, code: 'owner_modal_selection_required' };
    if (expectedModal !== undefined && expectedModal !== modalIdentity(target.modal)) return { success: false as const, code: 'owner_modal_selection_changed' };
    const issued = assistantExecution.issue(source, state, action, target.modal);
    if (!issued.success) return issued;
    return { success: true as const, expiresAt: issued.expiresAt, text: `${text}\n[ADHDev owner action] ${JSON.stringify({ ...action, authorization: issued.authorization, expiresAt: issued.expiresAt })}` };
}
