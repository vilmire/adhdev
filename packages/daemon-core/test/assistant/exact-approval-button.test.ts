/**
 * Worker permission policy — exact provider-button one-tap. resolve_action with
 * an `approvalTarget` now accepts an explicit provider button, but only a label
 * that is literally one of that live episode's buttons, whose index and
 * approve/reject polarity agree, while modalKey/attemptId/generation still
 * match. assistant_execution_state choices carry that authoritative identity
 * and owner consent is bound to it end to end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleResolveAction, readExactTargetButton } from '../../src/commands/chat-commands-write.js';
import { ProviderApprovalLifecycle } from '../../src/providers/spec/provider-approval-lifecycle.js';
import { assistantExecution, modalIdentity } from '../../src/assistant/assistant-execution.js';
import { ownerActionChoices, prepareOwnerActionChat } from '../../src/assistant/assistant-action-ingress.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { assistantActionSpecs } from '../../src/commands/high-family/assistant-action.js';

const BUTTONS = ['Yes', "Yes, and don't ask again for npm test", 'No'];
const modal = { message: 'Run npm test?', buttons: BUTTONS };

function episode(stateId = 'permission') {
    const lifecycle = new ProviderApprovalLifecycle();
    const state: any = { id: stateId, status: 'approval' };
    const parsed: any = { kind: 'approval', message: modal.message, buttons: BUTTONS.map((label, index) => ({ label, index })) };
    lifecycle.observe(state, parsed, 1000);
    const replace = () => { lifecycle.resolve(2000); lifecycle.observe({ id: 'busy', status: 'busy' } as any, null, 2100); lifecycle.observe(state, parsed, 3000); };
    return { lifecycle, replace };
}

function ptyHelper(lifecycle: ProviderApprovalLifecycle) {
    const resolveModalMatched = vi.fn(() => true);
    const adapter = { getStatus: () => ({ status: 'waiting_approval', activeModal: modal, providerApproval: lifecycle.read() }), resolveModalMatched };
    const helper: any = { getProvider: () => ({ type: 'codex-cli', category: 'cli' }), getCliAdapter: () => adapter,
        currentSession: { transport: 'pty', sessionId: 'worker', providerType: 'codex-cli' }, ctx: { instanceManager: { getInstance: () => null } } };
    return { helper, resolveModalMatched };
}

describe('readExactTargetButton', () => {
    it('passes through ordinary approve/reject and validates an explicit label', () => {
        expect(readExactTargetButton({ action: 'approve' }, BUTTONS)).toEqual({ ok: true, button: null });
        expect(readExactTargetButton({ action: 'approve', button: 'Yes', buttonIndex: 0 }, BUTTONS)).toEqual({ ok: true, button: 'Yes' });
        expect(readExactTargetButton({ action: 'reject', buttonText: 'No' }, BUTTONS)).toEqual({ ok: true, button: 'No' });
    });
    it.each([
        [{ action: 'approve', button: 'Ye' }, 'approval_button_not_offered'],
        [{ action: 'approve', button: 'Yes', buttonIndex: 1 }, 'approval_button_mismatch'],
        [{ action: 'approve', button: 'Yes', buttonText: 'No' }, 'approval_button_mismatch'],
        [{ action: 'approve', buttonIndex: 0 }, 'approval_button_required'],
        [{ action: 'approve', button: 'No' }, 'approval_button_action_mismatch'],
        [{ action: 'reject', button: 'Yes' }, 'approval_button_action_mismatch'],
    ])('refuses %j', (args, code) => {
        expect(readExactTargetButton(args, BUTTONS)).toMatchObject({ ok: false, code });
    });
});

describe('resolve_action exact provider button with approvalTarget', () => {
    it('presses exactly the named button for the matching episode', async () => {
        const { lifecycle } = episode();
        const { helper, resolveModalMatched } = ptyHelper(lifecycle);
        const approvalTarget = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        const out = await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', button: BUTTONS[1], approvalTarget });
        expect(out).toMatchObject({ success: true, buttonIndex: 1, button: BUTTONS[1] });
        expect(resolveModalMatched).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('refuses a replaced episode, an unoffered label or a disagreeing index without writing keys', async () => {
        const { lifecycle, replace } = episode();
        const { helper, resolveModalMatched } = ptyHelper(lifecycle);
        const stale = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', button: 'Yes, always', approvalTarget: stale }))
            .toMatchObject({ success: false, code: 'approval_button_not_offered' });
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', button: 'Yes', buttonIndex: 2, approvalTarget: stale }))
            .toMatchObject({ success: false, code: 'approval_button_mismatch' });
        replace();
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', button: 'Yes', approvalTarget: stale }))
            .toMatchObject({ success: false, stalePrompt: true });
        expect(resolveModalMatched).not.toHaveBeenCalled();
    });

    it('refuses an exact button for a setup/trust episode', async () => {
        const { lifecycle } = episode('trust');
        const { helper, resolveModalMatched } = ptyHelper(lifecycle);
        const target = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', button: 'Yes', approvalTarget: target }))
            .toMatchObject({ success: false, stalePrompt: true });
        expect(resolveModalMatched).not.toHaveBeenCalled();
    });

    it('ordinary approve on an exact target picks the one-time option', async () => {
        const { lifecycle } = episode();
        const { helper, resolveModalMatched } = ptyHelper(lifecycle);
        const approvalTarget = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', approvalTarget })).toMatchObject({ success: true, buttonIndex: 0 });
        expect(resolveModalMatched).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('ordinary approve on an exact target never presses a persistent grant, even when hints rank it first', async () => {
        const { lifecycle } = episode();
        const { helper, resolveModalMatched } = ptyHelper(lifecycle);
        helper.getProvider = () => ({ type: 'codex-cli', category: 'cli', approvalPositiveHints: ['yes and don t ask again for npm test', 'yes'] });
        const approvalTarget = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        expect(await handleResolveAction(helper, { targetSessionId: 'worker', action: 'approve', approvalTarget })).toMatchObject({ success: true, buttonIndex: 0 });
        expect(resolveModalMatched).toHaveBeenCalledExactlyOnceWith(0);
    });
});

let dir: string | undefined;
afterEach(() => { setAssistantRegistryForTests(null); setAssistantServicesForTests(null); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('assistant execution choices carry the authoritative episode', () => {
    function world(stateId = 'permission') {
        dir = mkdtempSync(join(tmpdir(), 'assistant-exact-'));
        const registry = new AssistantRegistry({ configDir: dir }); registry.bindSession({ sessionId: 'assistant', cliType: 'claude-cli', workspace: dir, at: 1 });
        setAssistantRegistryForTests(registry); setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [{ id: 'mesh' } as any] }));
        const { lifecycle, replace } = episode(stateId);
        const runtime = { getState: () => ({ type: 'claude-cli', settings: { assistant: true } }) }; const assistantAdapter = {};
        const worker = { getState: () => ({ category: 'cli', type: 'codex-cli', settings: { meshNodeFor: 'mesh', meshNodeId: 'node-w' }, activeChat: { activeModal: modal } }) };
        const workerAdapter = { getStatus: () => ({ status: 'waiting_approval', activeModal: modal, providerApproval: lifecycle.read() }) };
        const components = { sessionRegistry: { get: () => ({ transport: 'pty' }) }, instanceManager: { getInstance: (id: string) => id === 'assistant' ? runtime : id === 'worker' ? worker : null },
            cliManager: { adapters: new Map<string, any>([['assistant', assistantAdapter], ['worker', workerAdapter]]) } };
        assistantExecution.attest('assistant', runtime, assistantAdapter, 'claude-cli', ['--strict-mcp-config', '--tools=Read,WebSearch,WebFetch'], 'enforced');
        return { components, lifecycle, replace };
    }

    it('lists modalKey/attemptId/generation/providerType per choice and the daemon machine in the state reply', async () => {
        const { components, lifecycle } = world();
        const choices = ownerActionChoices(components);
        expect(choices.map(c => c.button)).toEqual(BUTTONS);
        expect(choices[0]).toMatchObject({ modalKey: lifecycle.read()!.modalKey, attemptId: null, generation: null, providerType: 'codex-cli' });
        const stateSpec = assistantActionSpecs.find(s => s.name === 'assistant_execution_state')!;
        const out: any = await stateSpec.run({ components: () => components, deps: { statusInstanceId: 'daemon_self' } } as any, { assistantSessionId: 'assistant' });
        expect(out.machine).toMatchObject({ daemonId: 'daemon_self', hostname: expect.any(String) });
        expect(out.choices[0]).toMatchObject({ daemonId: 'daemon_self', modalKey: lifecycle.read()!.modalKey });
    });

    it('never lists a setup/trust episode as an owner choice', () => {
        const { components } = world('trust');
        expect(ownerActionChoices(components)).toEqual([]);
    });

    it('binds consent to the episode and forwards it to resolve_action; a replaced episode is refused', async () => {
        const { components, lifecycle, replace } = world();
        const action = { meshId: 'mesh', targetSessionId: 'worker', action: 'approve' as const, button: 'Yes' };
        const target = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null };
        expect(prepareOwnerActionChat(components, 'ws', 'assistant', 'x', action, modalIdentity(modal), { ...target, modalKey: 'modal:other' }))
            .toMatchObject({ success: false, code: 'owner_modal_selection_changed' });
        const prepared = prepareOwnerActionChat(components, 'ws', 'assistant', 'x', action, modalIdentity(modal), target);
        if (!prepared.success || !('expiresAt' in prepared)) throw new Error('prepare failed');
        const cap = JSON.parse(prepared.text.split('[ADHDev owner action] ')[1]!);
        const calls: any[] = [];
        const handler = assistantActionSpecs.find(s => s.name === 'assistant_action')!;
        const ctx = { components: () => components, execute: async (...request: any[]) => { calls.push(request); return { success: true }; } } as any;
        expect((await handler.run(ctx, { ...action, authorization: cap.authorization, assistantSessionId: 'assistant' })).success).toBe(true);
        expect(calls[0][1]).toMatchObject({ approvalTarget: target, button: 'Yes', buttonIndex: 0 });
        replace();
        expect(prepareOwnerActionChat(components, 'ws', 'assistant', 'x', action, modalIdentity(modal), target))
            .toMatchObject({ success: false, code: 'owner_modal_selection_changed' });
    });
});
