/** D6: authority comes from a daemon-issued, owner-origin capability, never input-log attribution. */
import { createHash, randomBytes } from 'crypto';

export interface AssistantAction { meshId: string; targetSessionId: string; action: 'approve' | 'reject'; button: string }
export interface ExecutionState {
    sessionId: string | null; enabled: boolean; runtime: object | null; adapter: object | null;
    provider: string; assistant: boolean; policyRevision?: number;
}
interface Attestation { sessionId: string; runtime: object; adapter: object; provider: string; restriction: 'enforced' | 'prompt_only' }
/** Exact provider-approval episode a consent is bound to (null for a legacy adapter without lifecycle identity). */
export interface AssistantApprovalTarget { modalKey: string; attemptId: string | null; generation: number | null }
interface Consent { origin: 'OWNER'; sessionId: string; action: AssistantAction; modal: string; expiresAt: number; policyRevision: number; approvalTarget: AssistantApprovalTarget | null }

export function modalIdentity(modal: unknown): string {
    return createHash('sha256').update(JSON.stringify(modal)).digest('hex');
}
export function parseAssistantAction(raw: unknown): AssistantAction | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(k => !['meshId', 'targetSessionId', 'action', 'button'].includes(k))) return null;
    if (![r.meshId, r.targetSessionId, r.button].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) return null;
    if (r.action !== 'approve' && r.action !== 'reject') return null;
    return r as unknown as AssistantAction;
}
const actionKey = (a: AssistantAction) => JSON.stringify([a.meshId, a.targetSessionId, a.action, a.button]);

export class AssistantExecution {
    private attestation: Attestation | null = null;
    private consents = new Map<string, Consent>();
    /**
     * Bind execution to this exact live assistant session (runtime + adapter
     * identity). Any CLI may act once the owner turns execution on (owner
     * decision 2026-10-18: the switch is explicit, and frontier models keep to
     * the system prompt; a Claude-only gate only took the feature away). The
     * tool lock is still recorded: 'enforced' when the CLI's built-in tools are
     * locked by launch flags (claude-cli), 'prompt_only' otherwise, and the
     * dashboard says which. Every action still needs fresh owner consent.
     */
    attest(sessionId: string, runtime: object | null, adapter: object | null, provider: string, args: readonly string[], restriction: string): void {
        this.attestation = null; this.consents.clear();
        if (!runtime || !adapter) return;
        const locked = restriction === 'enforced' && provider === 'claude-cli'
            && args.filter(a => a.startsWith('--tools')).length === 1
            && args.includes('--tools=Read,WebSearch,WebFetch') && args.includes('--strict-mcp-config');
        this.attestation = { sessionId, runtime, adapter, provider, restriction: locked ? 'enforced' : 'prompt_only' };
    }
    /** How the bound assistant's tools are restricted, or null when none is bound. */
    toolRestriction(): 'enforced' | 'prompt_only' | null {
        return this.attestation?.restriction ?? null;
    }
    available(state: ExecutionState): boolean {
        const a = this.attestation;
        return state.enabled && state.assistant && !!a && a.sessionId === state.sessionId
            && a.runtime === state.runtime && a.adapter === state.adapter && a.provider === state.provider;
    }
    issue(source: unknown, state: ExecutionState, action: AssistantAction, modal: unknown, now = Date.now(), approvalTarget: AssistantApprovalTarget | null = null) {
        if (!['p2p', 'ws', 'standalone'].includes(String(source))) return { success: false as const, code: 'owner_origin_required' };
        if (!this.available(state)) return { success: false as const, code: state.enabled ? 'assistant_execution_not_enforced' : 'assistant_execution_off' };
        for (const [token, c] of this.consents) if (c.expiresAt <= now) this.consents.delete(token);
        if (this.consents.size >= 32) return { success: false as const, code: 'assistant_consent_capacity' };
        const authorization = randomBytes(32).toString('hex');
        const expiresAt = now + 2 * 60_000;
        this.consents.set(authorization, { origin: 'OWNER', sessionId: state.sessionId!, action: { ...action }, modal: modalIdentity(modal), expiresAt, policyRevision: state.policyRevision ?? 0,
            approvalTarget: approvalTarget ? { modalKey: approvalTarget.modalKey, attemptId: approvalTarget.attemptId, generation: approvalTarget.generation } : null });
        return { success: true as const, authorization, expiresAt };
    }
    consume(token: unknown, state: ExecutionState, action: AssistantAction, modal: unknown, now = Date.now()) {
        if (!this.available(state)) return { success: false as const, code: state.enabled ? 'assistant_execution_not_enforced' : 'assistant_execution_off' };
        const c = typeof token === 'string' ? this.consents.get(token) : undefined;
        if (!c) return { success: false as const, code: 'invalid_or_replayed_consent' };
        if (c.expiresAt <= now) { this.consents.delete(token as string); return { success: false as const, code: 'expired_consent' }; }
        if (c.policyRevision !== (state.policyRevision ?? 0)) return { success: false as const, code: 'consent_policy_changed' };
        if (c.origin !== 'OWNER' || c.sessionId !== state.sessionId || actionKey(c.action) !== actionKey(action) || c.modal !== modalIdentity(modal)) {
            return { success: false as const, code: 'consent_target_or_action_mismatch' };
        }
        // Burn before dispatch, even if the provider fails. A retry needs fresh owner consent.
        this.consents.delete(token as string);
        return { success: true as const, expectedModalIdentity: c.modal, expiresAt: c.expiresAt, approvalTarget: c.approvalTarget };
    }
}
export const assistantExecution = new AssistantExecution();

const executionGuards = new WeakMap<object, () => boolean>();
/** Object identity cannot arrive over JSON IPC or a provider text envelope. */
export function createAssistantExecutionGuard(check: () => boolean): object {
    const guard = {}; executionGuards.set(guard, check); return guard;
}
export function checkAssistantExecutionGuard(guard: unknown): boolean {
    return !!guard && typeof guard === 'object' && executionGuards.get(guard)?.() === true;
}
