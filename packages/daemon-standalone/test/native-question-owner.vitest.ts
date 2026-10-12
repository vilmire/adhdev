import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'native-question-owner-'));
});
import { CodexAppServerAdapter } from '../../daemon-core/src/providers/codex-app-server/adapter.js';
import { nativeQuestionHost } from '../../daemon-core/test/fixtures/native-question-host.js';
import { StandaloneHttpApi } from '../src/standalone-http.js';
import { createRouterInteractivePromptService } from '../src/interactive-prompt-http.js';
import { createPasswordRecord } from '../src/standalone-auth.js';

const servers: Server[] = [];
const adapters: CodexAppServerAdapter[] = [];
afterEach(async () => {
    adapters.splice(0).forEach(a => a.shutdown());
    await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
});
async function setup(mode = 'rpc') {
    const producer = fileURLToPath(new URL('../../daemon-core/test/fixtures/codex-question-producer.mjs', import.meta.url));
    const adapter = new CodexAppServerAdapter(process.cwd(), 'synthetic-session', process.execPath, [], {}, [producer]);
    adapters.push(adapter); await adapter.spawn(); await adapter.sendMessage(mode);
    await vi.waitFor(() => expect(adapter.questions.active()).not.toBeNull());
    const runtime = nativeQuestionHost(adapter);
    const api = new StandaloneHttpApi({ isReady: () => true, getStatus: () => ({}) as any,
        executeCommand: (cmd, args, source) => runtime.host.execute(cmd, args, source),
        interactivePromptService: () => createRouterInteractivePromptService(runtime.host),
        rawTerminalService: () => ({}) as any, isCliSession: () => true, createSessionHostClient: async () => ({}) as any,
        verifyWorkerCredential: credential => credential === 'synthetic-worker' });
    api.configureAuth('synthetic-owner'); api.internalAuthToken = 'synthetic-internal';
    api.passwordConfig = createPasswordRecord('synthetic-password');
    const server = createServer((req, res) => api.handle(req, res)); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    const base = `http://127.0.0.1:${address.port}`;
    const prompt = adapter.questions.active()!;
    const response = { promptId: prompt.promptId, binding: prompt.binding,
        answers: mode === 'rpc' ? { track: { selectedLabels: ['Beta'] }, note: { selectedLabels: [], freeformText: 'Synthetic note' } }
            : { [prompt.questions[0].questionId]: { selectedLabels: ['Blue'] } } };
    const post = (headers: Record<string, string>, data: unknown = response, dedicated = false) => fetch(
        dedicated ? `${base}/api/v1/sessions/synthetic-session/interactive-prompt/resolve` : `${base}/api/v1/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(dedicated ? data : { type: 'interactive_prompt_response', payload: {
                targetSessionId: 'synthetic-session', response: data, source: 'standalone', _commandSource: 'standalone' } }) });
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'synthetic-password' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    return { adapter, ...runtime, prompt, response, post, cookie };
}
const owner = { Authorization: 'Bearer synthetic-owner' };
describe('authenticated HTTP → host → router → callback → native process', () => {
    it('refuses internal, worker, foreign and forged authority without reserving the exact pending episode; owner succeeds once', async () => {
        const { adapter, host, prompt, response, post, cookie } = await setup();
        const submit = vi.spyOn(adapter, 'setInteractivePromptResponse');
        const rejectedCredentials: Record<string, string>[] = [{ Cookie: cookie, 'x-adhdev-internal-auth': 'synthetic-internal' },
            { Cookie: cookie, 'x-adhdev-worker-credential': 'synthetic-worker' }, { Authorization: 'Bearer synthetic-foreign-owner' }];
        for (const headers of rejectedCredentials) {
            const result = await post(headers); const body = await result.json() as any;
            expect(result.status !== 200 || body.success === false).toBe(true);
            expect(adapter.questions.active()).toBe(prompt); expect(prompt.lifecycle).toBe('pending');
        }
        for (const source of ['internal', 'ipc', 'api', 'ext', 'mesh', 'ws', 'p2p']) {
            expect((await host.execute('interactive_prompt_response', { targetSessionId: 'synthetic-session',
                response, source: 'standalone', _commandSource: 'standalone' }, source)).success).toBe(false);
            expect(adapter.questions.active()).toBe(prompt);
        }
        expect(submit).not.toHaveBeenCalled();
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.id === 'request-1')).toEqual([]);
        const success = await post(owner); expect(success.status).toBe(200); expect((await success.json() as any).success).toBe(true);
        await vi.waitFor(() => expect(adapter.questions.active()).toBeNull());
        expect(submit).toHaveBeenCalledTimes(1);
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.id === 'request-1'))
            .toEqual([{ id: 'request-1', result: { answers: { track: { answers: ['Beta'] }, note: { answers: ['Synthetic note'] } } } }]);
        expect((await (await post(owner)).json() as any).success).toBe(false);
        expect(submit).toHaveBeenCalledTimes(1);
    });
    it('dedicated HTTP endpoint carries authenticated authority and rejects every stale tuple before owner success', async () => {
        const { adapter, prompt, response, post } = await setup();
        for (const key of ['sessionId', 'generation', 'threadId', 'turnId', 'itemId', 'requestId']) {
            const bad = { ...response, binding: { ...response.binding, [key]: 'synthetic-foreign' } };
            expect((await (await post(owner, bad, true)).json() as any).success).not.toBe(true);
            expect(adapter.questions.active()).toBe(prompt); expect(prompt.lifecycle).toBe('pending');
        }
        for (const bad of [{ ...response, promptId: 'synthetic-stale-prompt' }, { ...response, action: 'cancel' },
            { ...response, unexpected: true }, { ...response, binding: { ...response.binding, unexpected: true } },
            { ...response, answers: { ...response.answers, track: { selectedLabels: ['Beta'], unexpected: true } } }]) {
            expect((await (await post(owner, bad, true)).json() as any).success).not.toBe(true);
            expect(adapter.questions.active()).toBe(prompt); expect(prompt.lifecycle).toBe('pending');
        }
        expect((await post({ ...owner, 'x-adhdev-internal-auth': 'synthetic-internal' }, response, true)).status).toBe(403);
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.id === 'request-1')).toEqual([]);
        expect((await post(owner, response, true)).status).toBe(200);
        await vi.waitFor(() => expect(adapter.questions.active()).toBeNull());
    });
    it('owner async reply steers the expected turn while internal exact replies cannot consume the episode', async () => {
        const { adapter, prompt, response, post } = await setup('async');
        expect((await (await post({ ...owner, 'x-adhdev-internal-auth': 'synthetic-internal' })).json() as any).success).toBe(false);
        expect(adapter.questions.active()).toBe(prompt);
        expect((await (await post(owner, response)).json() as any).success).toBe(true);
        const observations = await adapter.transport.request('test/observations', {}) as any[];
        expect(observations.some(o => o.method === 'turn/steer' && o.params.expectedTurnId === prompt.binding!.turnId)).toBe(true);
    });
    it('preserves type-sensitive numeric RPC identity through authenticated cookie HTTP', async () => {
        const { adapter, post, cookie } = await setup();
        const first = adapter.questions.active()!;
        await adapter.transport.request('test/emit', { method: 'serverRequest/resolved', params: {
            threadId: first.binding!.threadId, requestId: first.binding!.requestId } });
        await adapter.transport.request('test/emit', { id: 17, method: 'item/tool/requestUserInput', params: {
            threadId: first.binding!.threadId, turnId: first.binding!.turnId, itemId: 'synthetic-numeric-item', isBlocking: true,
            questions: [{ id: 'numeric', header: '', question: 'Synthetic numeric identity', isOther: false, isSecret: false,
                options: [{ label: 'One', description: 'Synthetic option' }] }] } });
        const prompt = adapter.questions.active()!;
        const response = { promptId: prompt.promptId, binding: prompt.binding, answers: { numeric: { selectedLabels: ['One'] } } };
        expect((await (await post({ Cookie: cookie }, { ...response, binding: { ...response.binding, requestId: '17' } })).json() as any).success).toBe(false);
        expect(adapter.questions.active()).toBe(prompt); expect(prompt.lifecycle).toBe('pending');
        expect((await (await post({ Cookie: cookie }, response)).json() as any).success).toBe(true);
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.id === 17))
            .toEqual([{ id: 17, result: { answers: { numeric: { answers: ['One'] } } } }]);
    });
    it('local async dismissal forwards the exact action without native steer or terminal skip', async () => {
        const { adapter, prompt, post } = await setup('async');
        const response = { promptId: prompt.promptId, binding: prompt.binding, answers: {}, action: 'dismiss' };
        const submit = vi.spyOn(adapter, 'setInteractivePromptResponse');
        expect((await (await post(owner, response)).json() as any).success).toBe(true);
        expect(submit).toHaveBeenCalledWith(response);
        expect((await adapter.transport.request('test/observations', {}) as any[]).filter(o => o.method === 'turn/steer')).toEqual([]);
        expect(adapter.questions.active()).toBeNull();
        expect(adapter.getStatus().status).toBe('generating');
    });
});
