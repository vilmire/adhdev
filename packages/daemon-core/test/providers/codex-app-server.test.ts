import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexAppServerAdapter } from '../../src/providers/codex-app-server/adapter.js';
import { normalizeInteractivePromptResponse } from '../../src/providers/types/interactive-prompt.js';
import { applyInteractivePromptAnswer } from '../../src/providers/interactive-prompt-apply.js';
import { createCliAdapter } from '../../src/providers/spec/route.js';

const producer = fileURLToPath(new URL('../fixtures/codex-question-producer.mjs', import.meta.url));
const running: CodexAppServerAdapter[] = [];
afterEach(() => { for (const adapter of running.splice(0)) adapter.shutdown(); });
async function start() {
    const adapter = new CodexAppServerAdapter(process.cwd(), 'synthetic-session', process.execPath, [], {}, [producer]);
    running.push(adapter); await adapter.spawn(); return adapter;
}
const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(predicate()).toBe(true);
};
const answer = (adapter: CodexAppServerAdapter) => {
    const prompt = adapter.questions.active()!;
    return { promptId: prompt.promptId, binding: prompt.binding, answers: { track: { selectedLabels: ['Beta'] }, note: { selectedLabels: [], freeformText: 'Synthetic note' } } };
};
const dispatch = (adapter: CodexAppServerAdapter, data: unknown) => applyInteractivePromptAnswer({ held: adapter.questions.active(), data, adapter, providerType: 'codex-cli' });

describe('managed Codex native process transport', () => {
    it('honors nonblocking RPC requests and supports partial answers without parking a generating turn', async () => {
        const adapter = await start(); await adapter.sendMessage('none');
        await adapter.transport.request('test/nonblocking', {});
        const prompt = adapter.questions.active()!;
        expect(prompt.blocking).toBe(false); expect(adapter.getStatus().status).toBe('generating');
        await dispatch(adapter, { promptId: prompt.promptId, binding: prompt.binding, answers: { note: { selectedLabels: [], freeformText: 'Synthetic partial response' } } });
        await wait(() => !adapter.questions.active());
        const received = await adapter.transport.request('test/observations', {}) as any[];
        expect(received.filter(o => o.id === 'request-1')[0].result.answers).toEqual({ note: { answers: ['Synthetic partial response'] } });
    });
    it('initializes experimental protocol and answers a native bundle once', async () => {
        const adapter = await start(); await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active());
        expect(adapter.getStatus().status).toBe('waiting_choice');
        const response = answer(adapter);
        await dispatch(adapter, response); await wait(() => !adapter.questions.active());
        await expect(dispatch(adapter, response)).rejects.toThrow();
        const observations = await adapter.transport.request('test/observations', {}) as any[];
        expect(observations[0].params.capabilities.experimentalApi).toBe(true);
        expect(observations.filter(o => o.id === 'request-1')).toEqual([{ id: 'request-1', result: { answers: { track: { answers: ['Beta'] }, note: { answers: ['Synthetic note'] } } } }]);
        expect(adapter.getScriptParsedStatus().messages.some(m => m.content === 'Synthetic question resolved')).toBe(true);
        await adapter.transport.request('test/replay', {});
        expect(adapter.questions.active()).toBeNull();
    });

    it('rejects malformed, unknown, missing, duplicate, foreign and stale answers before any native write', async () => {
        const adapter = await start(); await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active());
        const valid = answer(adapter);
        for (const data of [
            { ...valid, promptId: 'unknown' }, { ...valid, binding: { ...valid.binding, sessionId: 'foreign' } },
            { ...valid, binding: { ...valid.binding, generation: 'old' } }, { ...valid, binding: { ...valid.binding, turnId: 'foreign-turn' } },
            { ...valid, binding: { ...valid.binding, requestId: 'foreign-request' } }, { ...valid, binding: undefined },
            { ...valid, answers: { track: { selectedLabels: ['Beta'] } } }, { ...valid, answers: { ...valid.answers, unknown: { selectedLabels: [] } } },
            { ...valid, answers: { ...valid.answers, track: { selectedLabels: ['Beta', 'Beta'] } } },
            { ...valid, answers: { ...valid.answers, track: null } }, { ...valid, answers: { ...valid.answers, track: { selectedLabels: ['Unknown'] } } },
            { ...valid, answers: [{ select: 'Beta' }] },
        ]) await expect(dispatch(adapter, data)).rejects.toThrow();
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.id === 'request-1')).toEqual([]);
        expect(() => normalizeInteractivePromptResponse({ ...valid, answers: { track: null } })).toThrow();
    });

    it('retracts only matching direct native resolution and rejects old runtime generations', async () => {
        const adapter = await start(); await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active());
        const old = answer(adapter);
        await adapter.transport.request('test/emit', { method: 'serverRequest/resolved', params: { threadId: 'foreign', requestId: 'request-1' } });
        expect(adapter.questions.active()).not.toBeNull();
        await adapter.transport.request('test/emit', { method: 'serverRequest/resolved', params: { threadId: adapter.questions.threadId, requestId: 'foreign' } });
        expect(adapter.questions.active()).not.toBeNull();
        await adapter.transport.request('test/emit', { method: 'serverRequest/resolved', params: { threadId: adapter.questions.threadId, requestId: 'request-1' } });
        expect(adapter.questions.active()).toBeNull();
        adapter.shutdown();
        const recreated = await start(); await recreated.sendMessage('rpc'); await wait(() => !!recreated.questions.active());
        await expect(dispatch(recreated, { ...old, promptId: recreated.questions.active()!.promptId })).rejects.toThrow();
        await recreated.transport.request('test/death', {}).catch(() => {});
        await wait(() => !recreated.isAlive()); expect(recreated.questions.active()).toBeNull();
        await expect(dispatch(recreated, old)).rejects.toThrow();
    });

    it('uses turn-fenced ordinary async replies and product-local dismiss, without claiming terminal skip authority', async () => {
        const adapter = await start(); await adapter.sendMessage('async'); await wait(() => !!adapter.questions.active());
        const prompt = adapter.questions.active()!;
        expect(adapter.getStatus().status).toBe('generating'); expect(prompt.support).toBe('product_local');
        await adapter.transport.request('test/terminalSkip', {});
        expect(adapter.questions.active()).toBe(prompt); // Not a shared native cancellation signal.
        await dispatch(adapter, { promptId: prompt.promptId, binding: prompt.binding, answers: { [prompt.questions[0].questionId]: { selectedLabels: ['Blue'] } } });
        const remaining = adapter.questions.active()!;
        expect(remaining.questions).toHaveLength(1); expect(remaining.promptId).not.toBe(prompt.promptId);
        const observations = await adapter.transport.request('test/observations', {}) as any[];
        const steer = observations.find(o => o.method === 'turn/steer');
        expect(steer.params.expectedTurnId).toBe(prompt.binding!.turnId);
        expect(steer.params.input[0].text).toContain('send_user_message_question_reply');
        await dispatch(adapter, { promptId: remaining.promptId, binding: remaining.binding, answers: {}, action: 'dismiss' });
        expect(adapter.questions.active()).toBeNull();
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.method === 'turn/steer')).toHaveLength(1);
    });

    it('preserves history identity across pages, refuses history switch and keeps permissions distinct', async () => {
        const adapter = await start();
        await adapter.readHistoryPage(adapter.questions.threadId); const before = adapter.getScriptParsedStatus().messages;
        await adapter.readHistoryPage(adapter.questions.threadId); expect(adapter.getScriptParsedStatus().messages).toEqual(before);
        await expect(adapter.readHistoryPage('foreign')).rejects.toThrow();
        await adapter.sendMessage('permission'); await wait(() => adapter.getStatus().status === 'waiting_approval');
        expect(adapter.questions.active()).toBeNull(); expect(adapter.getStatus().activeModal?.buttons).toEqual([]);
        await expect(adapter.resolveAction({ action: 'approve' })).rejects.toThrow('exact owner');
        await expect(adapter.injectKeys()).rejects.toThrow('no terminal');
        expect(() => adapter.writeRaw('input')).toThrow('terminal input');
        await adapter.interruptTurn(); expect(adapter.questions.active()).toBeNull();
    });

    it('does not route an unsupported provider or attach into the new transport', () => {
        const provider = { type: 'claude-cli', spawn: { command: 'synthetic' }, _resolvedSpecPath: producer } as any;
        expect(() => createCliAdapter(provider, process.cwd(), [], {}, undefined, 'synthetic', undefined, undefined, true)).toThrow();
        const codex = { ...provider, type: 'codex-cli' };
        expect(() => createCliAdapter(codex, process.cwd(), [], {}, { attachesExistingRuntime: true } as any, 'synthetic', undefined, undefined, true)).toThrow('new managed');
        for (const args of [['resume', 'old-thread'], ['--remote', 'unix://'], ['--dangerously-bypass-approvals-and-sandbox']]) {
            expect(() => createCliAdapter(codex, process.cwd(), args, {}, undefined, 'synthetic', undefined, undefined, true)).toThrow('Unsupported startup');
        }
    });

    it('does not resurrect a completed turn from a late response or replayed turn event', async () => {
        const adapter = await start(); await adapter.sendMessage('complete-immediately');
        await wait(() => adapter.getStatus().status === 'idle');
        expect(adapter.questions.turnId).toBe('');
        await adapter.transport.request('test/emit', { method: 'turn/started', params: { threadId: adapter.questions.threadId, turn: { id: 'turn-1' } } });
        expect(adapter.questions.turnId).toBe('');
        await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active()); const old = answer(adapter);
        await adapter.transport.request('test/emit', { method: 'turn/completed', params: { threadId: adapter.questions.threadId, turn: { id: 'foreign-turn', status: 'completed' } } });
        expect(adapter.questions.active()).not.toBeNull();
        await adapter.transport.request('test/emit', { method: 'turn/started', params: { threadId: adapter.questions.threadId, turn: { id: 'new-turn' } } });
        expect(adapter.questions.active()).toBeNull();
        await expect(dispatch(adapter, old)).rejects.toThrow();
    });

    it('rejects malformed native requests and observes only exact current-turn async reply evidence', async () => {
        const adapter = await start(); await adapter.sendMessage('none');
        const native = { id: 'bad-request', method: 'item/tool/requestUserInput', params: { threadId: adapter.questions.threadId,
            turnId: adapter.questions.turnId, itemId: 'bad-item', isBlocking: true, questions: [{ id: 'q', header: 'Q', question: 'Synthetic question', options: [{ label: 'One', description: 1 }], isOther: true, isSecret: false }] } };
        await adapter.transport.request('test/emit', native);
        expect(adapter.questions.active()).toBeNull();
        await adapter.interruptTurn(); await adapter.sendMessage('async'); await wait(() => !!adapter.questions.active());
        const prompt = adapter.questions.active()!;
        const input = [{ type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: prompt.questions[0].questionId, question: prompt.questions[0].question, answer: 'Blue' }])}</send_user_message_question_reply>` }];
        const reply = { method: 'item/completed', params: { threadId: adapter.questions.threadId, turnId: 'foreign-turn', item: { id: 'reply', type: 'userMessage', content: input } } };
        await adapter.transport.request('test/emit', reply); expect(adapter.questions.active()!.questions).toHaveLength(2);
        reply.params.turnId = adapter.questions.turnId;
        await adapter.transport.request('test/emit', reply); expect(adapter.questions.active()!.questions).toHaveLength(1);
        await adapter.transport.request('test/emit', reply); expect(adapter.questions.active()!.questions).toHaveLength(1);
    });

    it('keeps native failure latched through runtime death, without manufacturing a successful completion', async () => {
        const adapter = await start(); await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active());
        const pending = answer(adapter);
        await adapter.transport.request('test/emit', { method: 'turn/completed', params: { threadId: adapter.questions.threadId, turn: { id: adapter.questions.turnId, status: 'failed', error: { message: 'Synthetic failure' } } } });
        expect(adapter.getStatus().status).toBe('error'); expect(adapter.questions.active()).toBeNull();
        await adapter.transport.request('test/death', {}).catch(() => {});
        expect(adapter.getStatus().status).toBe('error');
        await expect(dispatch(adapter, pending)).rejects.toThrow();
    });

    it('retires invalid native streams and prevents late frames from restoring actionable questions', async () => {
        const adapter = await start(); await adapter.sendMessage('rpc'); await wait(() => !!adapter.questions.active());
        const pending = answer(adapter);
        await adapter.transport.request('test/malformedOutput', {}).catch(() => {});
        expect(adapter.getStatus().status).toBe('error'); expect(adapter.questions.active()).toBeNull();
        await expect(dispatch(adapter, pending)).rejects.toThrow();
        await expect(adapter.spawn()).rejects.toThrow('already started');
    });
});
