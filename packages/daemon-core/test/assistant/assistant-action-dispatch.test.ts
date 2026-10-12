import { expect, it, vi } from 'vitest';
import { handleResolveAction } from '../../src/commands/chat-commands-write.js';
import { createAssistantExecutionGuard, modalIdentity } from '../../src/assistant/assistant-execution.js';
it('last approval dispatch checks current daemon authority and exact modal; forged/revoked guards write no keys', async () => {
    const modal = { message: 'Apply change?', buttons: ['Accept', 'Reject'] };
    const resolveModalMatched = vi.fn(() => true);
    const adapter = { getStatus: () => ({ status: 'waiting_approval', activeModal: modal }), resolveModalMatched };
    const helper: any = { getProvider: () => ({ type: 'claude-cli', category: 'cli' }), getCliAdapter: () => adapter,
        getCdp: () => null, currentSession: { transport: 'pty', sessionId: 'worker', providerType: 'claude-cli' },
        currentProviderType: 'claude-cli', ctx: { instanceManager: { getInstance: () => ({ getState: () => ({ activeChat: { activeModal: modal } }) }) } } };
    let enabled = true; const guard = createAssistantExecutionGuard(() => enabled);
    const args = { targetSessionId: 'worker', agentType: 'claude-cli', action: 'approve', button: 'Accept', buttonIndex: 0, expectedModalIdentity: modalIdentity(modal), assistantExecutionGuard: guard };
    enabled = false; expect((await handleResolveAction(helper, args)).success).toBe(false); expect(resolveModalMatched).not.toHaveBeenCalled();
    enabled = true; expect((await handleResolveAction(helper, { ...args, assistantExecutionGuard: { consent: true } })).success).toBe(false); expect(resolveModalMatched).not.toHaveBeenCalled();
    expect((await handleResolveAction(helper, { ...args, expectedModalIdentity: modalIdentity({ ...modal, message: 'different operation' }) })).success).toBe(false); expect(resolveModalMatched).not.toHaveBeenCalled();
    expect((await handleResolveAction(helper, args)).success).toBe(true); expect(resolveModalMatched).toHaveBeenCalledExactlyOnceWith(0);
});
it.each(['cdp-webview', 'cdp-page'])('refuses D6 guards before any %s transport dispatch or current-session fallback', async transport => {
    const dispatch = vi.fn();
    const helper: any = { getProvider: () => ({ type: 'extension', category: 'extension' }),
        currentSession: { transport, sessionId: 'unrelated-current' }, agentStream: { resolveAction: dispatch }, getCdp: dispatch, evaluateProviderScript: dispatch };
    const result = await handleResolveAction(helper, { targetSessionId: 'exact-target', action: 'approve',
        expectedModalIdentity: 'modal', assistantExecutionGuard: createAssistantExecutionGuard(() => true) });
    expect(result).toMatchObject({ success: false, code: 'assistant_action_transport_unsupported' });
    expect(dispatch).not.toHaveBeenCalled();
});

it('guarded PTY approvals cannot bypass modal matching through data payloads or legacy void resolver fallback', async () => {
    const modal = { message: 'Write file?', buttons: ['Accept'] }; const dispatch = vi.fn();
    const adapter = { getStatus: () => ({ status: 'waiting_approval', activeModal: modal }), resolveAction: dispatch, resolveModal: dispatch };
    const helper: any = { getProvider: () => ({ type: 'claude-cli', category: 'cli' }), getCliAdapter: () => adapter,
        currentSession: { transport: 'pty', sessionId: 'worker', providerType: 'claude-cli' }, ctx: { instanceManager: { getInstance: () => ({ getState: () => ({ activeChat: { activeModal: modal } }) }) } } };
    const args = { targetSessionId: 'worker', action: 'approve', button: 'Accept', buttonIndex: 0,
        expectedModalIdentity: modalIdentity(modal), assistantExecutionGuard: createAssistantExecutionGuard(() => true) };
    expect(await handleResolveAction(helper, { ...args, data: { operation: 'other' } })).toMatchObject({ success: false, code: 'assistant_action_payload_unsupported' });
    expect(await handleResolveAction(helper, args)).toMatchObject({ success: false, code: 'assistant_action_transport_unsupported' });
    expect(dispatch).not.toHaveBeenCalled();
});
