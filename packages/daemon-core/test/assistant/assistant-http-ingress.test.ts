import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StandaloneHttpApi } from '../../../daemon-standalone/src/standalone-http.js';
import { createDaemonHostRuntime, type DaemonHostRuntime } from '../../src/boot/host-runtime.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { handleSendChat } from '../../src/commands/chat-commands-write.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { SessionOutputFanout } from '../../src/boot/session-output-fanout.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { OutgoingReceiptStore } from '../../src/sessions/outgoing-receipt-store.js';
import { assistantExecution } from '../../src/assistant/assistant-execution.js';

let server: Server | undefined, host: DaemonHostRuntime | undefined, dir: string | undefined;
const originalConfig = process.env.ADHDEV_CONFIG_DIR;
afterEach(async () => {
    host?.stop(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    setAssistantRegistryForTests(null); setAssistantServicesForTests(null);
    if (originalConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = originalConfig;
    if (dir) rmSync(dir, { recursive: true, force: true });
});
it('real HTTP scope → host → router → send_chat never grants owner authority to internal credentials or forged source envelopes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'assistant-http-chain-')); process.env.ADHDEV_CONFIG_DIR = dir;
    const registry = new AssistantRegistry({ configDir: dir }); registry.bindSession({ sessionId: 'assistant', cliType: 'claude-cli', workspace: dir, at: 1 });
    setAssistantRegistryForTests(registry); setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [{ id: 'mesh' } as any] }));
    const modal = { message: 'Write file?', buttons: ['Accept', 'Reject'] };
    const runtime = { category: 'cli', getState: () => ({ category: 'cli', type: 'claude-cli', settings: { assistant: true } }) };
    const worker = { category: 'cli', getState: () => ({ category: 'cli', settings: { meshNodeFor: 'mesh' }, activeChat: { activeModal: modal } }) };
    const adapter = { cliType: 'claude-cli', getStatus: () => ({ activeModal: modal }) };
    const adapters = new Map([['assistant', adapter], ['worker', adapter]]);
    const instanceManager: any = { getInstance: (id: string) => id === 'assistant' ? runtime : id === 'worker' ? worker : null, collectAllStates: () => [], listInstanceIds: () => ['assistant', 'worker'] };
    const bus = createSessionLifecycleBus(); const sessionRegistry = new SessionRegistry(bus);
    for (const id of ['assistant','worker']) sessionRegistry.register({ sessionId: id, instanceKey: id, adapterKey: id, providerType: 'claude-cli', transport: 'pty' } as any);
    const submitted: string[] = [];
    // Exercise reservation, preparation and receipt lookup through the real service.
    // This synthetic target supplies no native write ACK, so delivery stays uncertain.
    const sessionInput = createSessionInputService({
        receiptStore: new OutgoingReceiptStore(join(dir, 'outgoing-receipts')),
        resolveSession: id => id === 'assistant' ? {
            getStatus: () => ({ status: 'idle' }),
            sendMessage: async text => { submitted.push(text); return { status: 'delivered' }; },
        } : null,
    });
    const helper: any = { getProvider: () => ({ type: 'claude-cli', category: 'cli' }), getCliAdapter: (id: string) => adapters.get(id),
        currentSession: sessionRegistry.get('assistant'), ctx: { adapters, instanceManager, sessionRegistry,
            sessionInput } };
    const commandHandler: any = { handleSpec: async (_spec: unknown, args: any) => handleSendChat(helper, args) };
    const providerLoader: any = { getAll: () => [], resolve: () => null };
    const deps: any = { commandHandler, cliManager: { adapters }, cdpManagers: new Map(), providerLoader, instanceManager, detectedIdes: { value: [] }, sessionRegistry };
    const router = new DaemonCommandRouter(deps);
    const components: any = { ...deps, bus, router, outputFanout: new SessionOutputFanout() }; router.attachComponents(components);
    host = createDaemonHostRuntime({ components, bus, seqscribe: null } as any, { kind: 'standalone', instanceId: () => 'standalone_test', version: 'test', topicSink: { send: () => true, isAlive: () => true, isDeliverable: () => true }, broadcastSessionOutput: () => {}, sendStatusEvent: () => {} });
    assistantExecution.attest('assistant', runtime, adapter, 'claude-cli', ['--strict-mcp-config','--tools=Read,WebSearch,WebFetch'], 'enforced');
    const http = new StandaloneHttpApi({ isReady: () => true, getStatus: () => ({}) as any, executeCommand: (type, payload, source) => host!.execute(type, payload, source), rawTerminalService: () => ({}) as any, interactivePromptService: () => ({}) as any, isCliSession: () => true, createSessionHostClient: async () => ({}) as any, verifyWorkerCredential: credential => credential === 'worker-bind' });
    http.passwordConfigPath = join(dir, 'password.json'); http.configureAuth('owner-token'); http.internalAuthToken = 'internal-token';
    server = createServer((req, res) => http.handle(req, res)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = async (type: string, headers: Record<string,string>, payload: any) => (await fetch(`${base}/api/v1/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ type, payload, source: 'standalone' }) })).json() as Promise<any>;
    const action = { meshId: 'mesh', targetSessionId: 'worker', action: 'approve', button: 'Accept' };
    const message = '/assistant-action ' + JSON.stringify(action);
    const internal = { 'x-adhdev-internal-auth': 'internal-token' };
    expect(await call('assistant_execution_settings', internal, { enabled: false })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    const internalPayload = { targetSessionId: 'assistant', messageId: 'synthetic-internal', message, _commandSource: 'standalone', promptSource: 'OWNER' };
    const internalResult = await call('send_chat', internal, internalPayload);
    expect(internalResult).toMatchObject({ success: true, outgoingReceipt: { messageId: internalPayload.messageId, sessionId: 'assistant', state: 'uncertain', proof: 'none' } });
    expect(await call('send_chat', internal, internalPayload)).toMatchObject({ success: true, deduplicated: true, outgoingReceipt: internalResult.outgoingReceipt });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(message);
    expect(await call('send_chat', { 'x-adhdev-worker-credential': 'worker-bind' }, { targetSessionId: 'assistant', message })).toMatchObject({ success: false, code: 'worker_scope_forbidden' });
    expect(await call('send_chat', { Authorization: 'Bearer owner-token' }, { targetSessionId: 'assistant', message })).toMatchObject({ success: true, ownerActionExpiresAt: expect.any(Number) });
    expect(submitted[1]).toContain('[ADHDev owner action]');
    expect(await call('assistant_execution_settings', { Authorization: 'Bearer owner-token', ...internal }, { enabled: false })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(await call('assistant_memory_limits', { Authorization: 'Bearer owner-token' }, { action: 'set', memory: 100, user: 10000 })).toMatchObject({
        success: false,
        code: 'out_of_range',
        min: { memory: 2200, user: 1375 },
        max: { memory: 8800, user: 5500 },
    });
    expect(await call('assistant_memory_limits', { Authorization: 'Bearer owner-token' }, { action: 'set', memory: 4400, user: 2750 })).toMatchObject({
        success: true,
        result: 'applied',
        limits: { memory: 4400, user: 2750 },
    });
    http.configureAuth(null);
    expect(await call('send_chat', {}, { targetSessionId: 'assistant', message })).toMatchObject({ success: true });
    expect(submitted[2]).toBe(message); // no configured owner authentication is not owner consent
    expect(await call('assistant_execution_settings', internal, { enabled: false })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(await call('assistant_memory_limits', {}, { action: 'get' })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    expect(await call('assistant_memory_limits', {}, { action: 'set', memory: 4400, user: 2750 })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
});
