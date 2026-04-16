/**
 * ProviderStreamAdapter — generic Extension adapter based on provider.js
 * 
 * Consolidates ClineAdapter, RooCodeAdapter, ContinueAdapter.
 * Auto-configured using provider.js scripts + metadata.
 */

import type {
    IAgentStreamAdapter,
    AgentStreamState,
    AgentChatListItem,
    AgentEvaluateFn,
} from './types.js';
import type { ProviderModule, ProviderScripts, FocusEditorResult, OpenPanelResult } from '../providers/contracts.js';
import { extractProviderControlValues, normalizeProviderEffects } from '../providers/control-effects.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { resolveProviderStateSurface } from '../providers/provider-patch-state.js';
import { normalizeChatMessages } from '../providers/chat-message-normalization.js';

export class ProviderStreamAdapter implements IAgentStreamAdapter {
    readonly agentType: string;
    readonly agentName: string;
    readonly extensionId: string;
    readonly extensionIdPattern: RegExp;
    private provider: ProviderModule;
    private lastSuccessState: AgentStreamState | null = null;

    constructor(provider: ProviderModule) {
        this.provider = provider;
        this.agentType = provider.type;
        this.agentName = provider.displayName || provider.name;
        this.extensionId = provider.extensionId || provider.type;
        this.extensionIdPattern = provider.extensionIdPattern
            || new RegExp(`extensionId=${this.extensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    }

    private callScript(name: string, ...args: any[]): string | null {
        const fn = this.provider.scripts?.[name];
        if (typeof fn !== 'function') return null;
        return fn(...args) || null;
    }

    private hasScript(name: string): boolean {
        return typeof this.provider.scripts?.[name] === 'function';
    }

    private getStateTitle(state: AgentStreamState): string {
        return typeof state.title === 'string' ? state.title : '';
    }

    private parseMaybeJson(raw: unknown): any {
        if (typeof raw !== 'string') return raw;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }

    private getOptionalError(raw: unknown): string | undefined {
        return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    }

    private normalizeFocusEditorResult(raw: unknown): FocusEditorResult {
        const data = this.parseMaybeJson(raw);
        if (data === true) return { focused: true };
        if (data === false || data == null) return { focused: false };
        if (typeof data === 'string') {
            const trimmed = data.trim();
            const normalized = trimmed.toLowerCase();
            if (
                normalized === 'true'
                || normalized === 'ok'
                || normalized === 'success'
                || normalized === 'focused'
                || normalized === 'visible'
            ) {
                return { focused: true };
            }
            if (
                normalized === 'false'
                || normalized === 'not_found'
                || normalized === 'not found'
                || normalized === 'missing'
                || normalized === 'panel_hidden'
                || normalized === 'hidden'
            ) {
                return { focused: false };
            }
            return { focused: false, ...(trimmed ? { error: trimmed } : {}) };
        }
        if (data && typeof data === 'object') {
            const error = this.getOptionalError(data.error);
            if (data.focused === true || data.success === true || data.ok === true || data.visible === true) {
                return { focused: true };
            }
            if (data.focused === false || data.success === false || data.ok === false || error) {
                return { focused: false, ...(error ? { error } : {}) };
            }
        }
        return { focused: false };
    }

    private normalizeOpenPanelResult(raw: unknown): OpenPanelResult {
        const data = this.parseMaybeJson(raw);
        if (data === true) return { opened: true, visible: true };
        if (data === false || data == null) return { opened: false, visible: false };
        if (typeof data === 'string') {
            const trimmed = data.trim();
            const normalized = trimmed.toLowerCase();
            if (
                normalized === 'true'
                || normalized === 'ok'
                || normalized === 'opened'
                || normalized === 'open'
                || normalized === 'success'
            ) {
                return { opened: true, visible: true };
            }
            if (normalized === 'visible') {
                return { opened: false, visible: true };
            }
            if (normalized === 'focused') {
                return { opened: false, visible: true, focused: true };
            }
            if (
                normalized === 'false'
                || normalized === 'panel_hidden'
                || normalized === 'hidden'
                || normalized === 'not_found'
                || normalized === 'not found'
                || normalized === 'missing'
            ) {
                return { opened: false, visible: false };
            }
            return { opened: false, visible: false, ...(trimmed ? { error: trimmed } : {}) };
        }
        if (data && typeof data === 'object') {
            const error = this.getOptionalError(data.error);
            const focused = data.focused === true;
            const visible = data.visible === true
                || data.opened === true
                || focused
                || data.success === true
                || data.ok === true;
            if (visible) {
                return {
                    opened: data.opened === true,
                    visible: true,
                    ...(focused ? { focused: true } : {}),
                };
            }
            if (data.opened === false || data.visible === false || data.success === false || data.ok === false || error) {
                return {
                    opened: false,
                    visible: false,
                    ...(error ? { error } : {}),
                };
            }
        }
        return { opened: false, visible: false };
    }

    private summarizeRaw(raw: unknown): string {
        try {
            if (typeof raw === 'string') return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
            if (raw == null) return String(raw);
            return JSON.stringify(raw).replace(/\s+/g, ' ').trim().slice(0, 240);
        } catch {
            return Object.prototype.toString.call(raw);
        }
    }

    private isTransportError(reason: string): boolean {
        return /Session with given id not found/i.test(reason)
            || /CDP not connected/i.test(reason)
            || /Target closed/i.test(reason)
            || /WebSocket not open/i.test(reason)
            || /not connected/i.test(reason)
            || /execution context/i.test(reason)
            || /Cannot find context with specified id/i.test(reason);
    }

    private titlesMatch(actual: string, expected: string): boolean {
        const lhs = actual.trim().toLowerCase();
        const rhs = expected.trim().toLowerCase();
        if (!lhs || !rhs) return false;
        return lhs === rhs || lhs.includes(rhs) || rhs.includes(lhs);
    }

    private messageCount(state: AgentStreamState | null | undefined): number {
        return Array.isArray(state?.messages) ? state!.messages.length : 0;
    }

    private lastMessageSignature(state: AgentStreamState | null | undefined): string {
        const messages = Array.isArray(state?.messages) ? state!.messages : [];
        const last = messages[messages.length - 1];
        if (!last) return '';
        return `${last.role || ''}:${String(last.content || '').replace(/\s+/g, ' ').trim()}`;
    }

    private async verifySendOutcome(
        evaluate: AgentEvaluateFn,
        before: AgentStreamState | null,
    ): Promise<boolean> {
        const beforeCount = this.messageCount(before);
        const beforeSignature = this.lastMessageSignature(before);

        for (let attempt = 0; attempt < 12; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            let state: AgentStreamState;
            try {
                state = await this.readChat(evaluate);
            } catch {
                continue;
            }

            if (state.status === 'waiting_approval') {
                return true;
            }

            const afterCount = this.messageCount(state);
            const afterSignature = this.lastMessageSignature(state);
            if (afterCount > beforeCount) return true;
            if (afterSignature && afterSignature !== beforeSignature) return true;
        }

        return false;
    }

    private async readStableBaselineState(evaluate: AgentEvaluateFn): Promise<AgentStreamState | null> {
        const first = await this.readChat(evaluate);
        if (this.messageCount(first) > 0 || this.lastMessageSignature(first)) {
            return first;
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
        const second = await this.readChat(evaluate);
        return this.messageCount(second) >= this.messageCount(first) ? second : first;
    }

    async readChat(evaluate: AgentEvaluateFn): Promise<AgentStreamState> {
        const script = this.callScript('readChat');
        if (!script) return this.errorState('readChat script not available');

        let raw: unknown = null;
        try {
            raw = await evaluate(script) as string;
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data?.error) {
                const state = this.errorState(data.error);
                if (this.lastSuccessState?.messages?.length) {
                    state.messages = this.lastSuccessState.messages;
                }
                return state;
            }
            const validated = validateReadChatResultPayload(data, `${this.agentType} readChat`);
            const validatedStatus = (validated as any).status as string;
            const streamStatus = validatedStatus === 'generating' || validatedStatus === 'long_generating'
                ? 'streaming'
                : validatedStatus;
            const state: AgentStreamState = {
                agentType: this.agentType,
                agentName: this.agentName,
                extensionId: this.extensionId,
                status: streamStatus as AgentStreamState['status'],
                messages: normalizeChatMessages(validated.messages) as any,
                inputContent: typeof validated.inputContent === 'string' ? validated.inputContent : '',
                ...(validated.activeModal ? { activeModal: validated.activeModal } : {}),
            };
            if (typeof validated.title === 'string' && validated.title.trim()) {
                state.title = validated.title.trim();
            }
            const providerSessionId = typeof validated.providerSessionId === 'string' && validated.providerSessionId.trim()
                ? validated.providerSessionId.trim()
                : '';
            if (providerSessionId) {
                state.sessionId = providerSessionId;
                state.providerSessionId = providerSessionId;
            }
            const controlValues = extractProviderControlValues(this.provider.controls, validated);
            const surface = resolveProviderStateSurface({
                controlValues,
                summaryMetadata: validated.summaryMetadata,
            });
            if (surface.controlValues) state.controlValues = surface.controlValues;
            if (surface.summaryMetadata) state.summaryMetadata = surface.summaryMetadata as any;
            const effects = normalizeProviderEffects(validated);
            if (effects.length > 0) state.effects = effects;
            if (state.messages.length > 0) {
                this.lastSuccessState = state;
            }
            return state;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (this.isTransportError(reason)) {
                throw (error instanceof Error ? error : new Error(reason));
            }
            const preview = this.summarizeRaw(raw);
            const detail = preview ? ` (reason=${reason}; raw=${preview})` : ` (reason=${reason})`;
            const state = this.errorState(`Failed to parse ${this.agentName} state${detail}`);
            if (this.lastSuccessState?.messages?.length) {
                state.messages = this.lastSuccessState.messages;
            }
            return state;
        }
    }

    async sendMessage(evaluate: AgentEvaluateFn, text: string): Promise<void> {
        let beforeState: AgentStreamState | null = null;
        try {
            beforeState = await this.readStableBaselineState(evaluate);
        } catch {
            beforeState = null;
        }

        const params = { message: text };
        const script = this.callScript('sendMessage', params) || this.callScript('sendMessage', text);
        if (!script) throw new Error(`[${this.agentName}] sendMessage script not available`);
        const result = await evaluate(script) as string;
        if (result && typeof result === 'string' && result.startsWith('error:')) {
            throw new Error(`[${this.agentName}] sendMessage failed: ${result}`);
        }

        const parsed = this.parseMaybeJson(result);
        if (parsed === true) return;
        if (typeof parsed === 'string') {
            const normalized = parsed.trim().toLowerCase();
            if (normalized === 'ok' || normalized === 'sent' || normalized === 'success' || normalized === 'true') {
                return;
            }
        }
        if (parsed && typeof parsed === 'object') {
            if (parsed.sent === true || parsed.success === true || parsed.ok === true || parsed.submitted === true || parsed.dispatched === true) {
                const verified = await this.verifySendOutcome(evaluate, beforeState);
                if (verified) return;
                throw new Error(`[${this.agentName}] sendMessage was not observed in chat state`);
            }
            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                throw new Error(`[${this.agentName}] sendMessage failed: ${parsed.error}`);
            }
        }

        throw new Error(`[${this.agentName}] sendMessage was not confirmed`);
    }

    async resolveAction(evaluate: AgentEvaluateFn, action: string, button?: string): Promise<boolean> {
        const script = this.callScript('resolveAction', { action, button });
        if (!script) return false; // Not supported if provider has no resolveAction
        const result = await evaluate(script);
        const parsed = this.parseMaybeJson(result);
        if (parsed === true) return true;
        if (typeof parsed === 'string') {
            const normalized = parsed.trim().toLowerCase();
            return normalized === 'ok'
                || normalized === 'success'
                || normalized === 'true'
                || normalized === 'resolved'
                || normalized === 'approved'
                || normalized === 'rejected';
        }
        if (!parsed || typeof parsed !== 'object') return false;
        return parsed.resolved === true
            || parsed.success === true
            || parsed.ok === true
            || parsed.found === true;
    }

    async newSession(evaluate: AgentEvaluateFn): Promise<void> {
        const script = this.callScript('newSession');
        if (!script) throw new Error(`[${this.agentName}] newSession script not available`);
        const result = await evaluate(script) as string;
        if (result && typeof result === 'string' && result.startsWith('error:')) {
            throw new Error(`[${this.agentName}] newSession failed: ${result}`);
        }
        this.lastSuccessState = null;
    }

    async listChats(evaluate: AgentEvaluateFn): Promise<AgentChatListItem[]> {
        const script = this.callScript('listSessions');
        if (!script) return [];
        try {
            const raw = await evaluate(script, 10000) as string;
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (data?.error) return [];
            if (Array.isArray(data)) return data;
            if (Array.isArray(data?.sessions)) return data.sessions;
            if (Array.isArray(data?.chats)) return data.chats;
            return [];
        } catch { return []; }
    }

    async switchSession(evaluate: AgentEvaluateFn, sessionId: string): Promise<boolean> {
        const script = this.callScript('switchSession', sessionId);
        if (!script) return false;
        const raw = await evaluate(script, 10000);
        const data = this.parseMaybeJson(raw);
        if (data === true) return true;
        if (typeof data === 'string') {
            const normalized = data.trim().toLowerCase();
            return normalized === 'true' || normalized === 'ok' || normalized === 'switched' || normalized === 'success';
        }
        if (data && typeof data === 'object') {
            if (data.switched === true || data.success === true || data.ok === true) return true;
            if (typeof data.error === 'string' && data.error.trim()) return false;
        }

        for (let attempt = 0; attempt < 6; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const state = await this.readChat(evaluate);
            const title = this.getStateTitle(state);
            if (this.titlesMatch(title, sessionId)) return true;
        }
        return false;
    }

    async focusEditor(evaluate: AgentEvaluateFn): Promise<FocusEditorResult> {
        const script = this.callScript('focusEditor');
        if (!script) return { focused: false };
        const raw = await evaluate(script);
        return this.normalizeFocusEditorResult(raw);
    }

    async openPanel(evaluate: AgentEvaluateFn): Promise<OpenPanelResult> {
        const script = this.callScript('openPanel');
        if (!script) return { opened: false, visible: false };
        const raw = await evaluate(script);
        return this.normalizeOpenPanelResult(raw);
    }

    private errorState(message: string): AgentStreamState {
        return {
            agentType: this.agentType,
            agentName: this.agentName,
            extensionId: this.extensionId,
            status: 'error',
            messages: [],
            inputContent: '',
            _error: message,
        };
    }
}
