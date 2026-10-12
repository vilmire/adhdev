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
