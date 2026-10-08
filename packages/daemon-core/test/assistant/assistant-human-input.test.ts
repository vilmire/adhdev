/**
 * Human input attribution into the assistant input log (design
 * 2026-10-07-assistant-layer.md §4.10.2 check 5, §4.10.7;
 * assistant/assistant-human-input.ts):
 *  - the router stamps the command source on `send_chat` (never the caller);
 *  - a dashboard (`ws`/`p2p`/`standalone`) send_chat into the bound assistant
 *    session is logged `human`, once, at delivery — so a memory write in that
 *    window applies instead of staging;
 *  - `api` / unknown sources and other sessions are not logged;
 *  - a FIFO-parked human input is logged when the drain writes it, in order.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB, type SendPolicy, type SubmitOutcome } from '@adhdev/mesh-shared';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { COMMAND_SOURCE_ARG } from '../../src/commands/command-args.js';
import { handleSendChat } from '../../src/commands/chat-commands.js';
import type { CommandHelpers } from '../../src/commands/handler.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import { createAssistantServices, setAssistantServicesForTests, type AssistantServices } from '../../src/assistant/assistant-services.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantRelay, type AssistantRelayBusEvent } from '../../src/assistant/assistant-relay.js';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { isHumanCommandSource } from '../../src/assistant/assistant-human-input.js';

const SID = 'asst_1';
const OTHER = 'coder_1';

let dir: string;
let svc: AssistantServices;
let runtime: AssistantRuntime | null = null;
let prevConfigDir: string | undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-human-'));
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = dir;
    svc = createAssistantServices({ configDir: dir, listMeshes: () => [] });
    setAssistantServicesForTests(svc);
});
afterEach(() => {
    runtime?.dispose();
    runtime = null;
    setAssistantServicesForTests(null);
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
});

describe('router stamps the command source on send_chat', () => {
    function createRouter() {
        const handleSpec = vi.fn(async (_spec: unknown, args: Record<string, unknown>) => ({ success: true, args }));
        const router = new DaemonCommandRouter({
            commandHandler: { handleSpec, rejectUnknown: vi.fn(async () => ({ success: false })) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
            detectedIdes: { value: [] },
            sessionRegistry: { get: () => undefined } as any,
            bus: createSessionLifecycleBus(),
        });
        return { router, handleSpec };
    }

    it('overwrites a caller-supplied source with the real one, and only for send_chat', async () => {
        const { router, handleSpec } = createRouter();
        await router.execute('send_chat', { targetSessionId: SID, message: 'hi', [COMMAND_SOURCE_ARG]: 'p2p' }, 'api');
        expect(handleSpec.mock.calls[0]![1][COMMAND_SOURCE_ARG]).toBe('api');
        await router.execute('send_chat', { targetSessionId: SID, message: 'hi' }, 'p2p');
        expect(handleSpec.mock.calls[1]![1][COMMAND_SOURCE_ARG]).toBe('p2p');
        await router.execute('read_chat', { targetSessionId: SID, [COMMAND_SOURCE_ARG]: 'p2p' }, 'ipc');
        expect(handleSpec).toHaveBeenCalledTimes(3);
        expect(COMMAND_SOURCE_ARG in handleSpec.mock.calls[2]![1]).toBe(false);
    });

    it('human sources are exactly the dashboards', () => {
        for (const s of ['ws', 'p2p', 'standalone']) expect(isHumanCommandSource(s)).toBe(true);
        for (const s of ['api', 'mesh', 'ipc', 'internal', 'ext', 'unknown', undefined, '']) expect(isHumanCommandSource(s)).toBe(false);
    });
});

describe('dashboard send_chat into the assistant session', () => {
    function setup(adapterOutcome: () => { status: 'delivered' } | { status: 'queued'; position: number } = () => ({ status: 'delivered' })) {
        const registry = new AssistantRegistry({ configDir: dir });
        registry.bindSession({ sessionId: SID, cliType: 'claude-cli', workspace: dir, at: 1 });
        svc.inputLog.begin(SID);
        const parked = new Set<string>();
        runtime = wireAssistantRuntime({
            bus: { on: () => () => {} },
            instanceManager: { getInstance: () => undefined },
            router: { execute: async () => ({ success: true }) },
            cliManager: { input: { submit: async () => ({ kind: 'delivered' }), isParked: async (_s: string, id: string) => parked.has(id) } },
        } as any, { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000 });
        const mkAdapter = () => ({
            cliType: 'claude-cli',
            getStatus: () => ({ status: 'idle' }),
            async sendMessage(_text: string, opts?: { messageId?: string }) {
                const r = adapterOutcome();
                if (r.status === 'queued' && opts?.messageId) parked.add(opts.messageId);
                return r;
            },
            hasQueuedSend: (id: string) => parked.has(id),
        });
        const adapters = new Map<string, any>([[SID, mkAdapter()], [OTHER, mkAdapter()]]);
        const helpers = {
            currentSession: { sessionId: SID, transport: 'pty' },
            currentManagerKey: 'mgr',
            currentProviderType: 'claude-cli',
            getProvider: () => undefined,
            getCliAdapter: (key: string) => adapters.get(key) ?? null,
            ctx: { adapters },
        } as unknown as CommandHelpers;
        const send = (messageId: string, source: string | undefined, target = SID) =>
            handleSendChat(helpers, { targetSessionId: target, message: `body ${messageId}`, messageId, ...(source ? { [COMMAND_SOURCE_ARG]: source } : {}) });
        return { send, parked, registry };
    }
    const addUser = (text: string) => assistantStoreHandlers[ASSISTANT_VERB.memory]({} as any, { action: 'add', target: 'user', text, assistantSessionId: SID });

    it('logs a p2p dashboard send as human, so a USER memory write in that window applies', async () => {
        const { send } = setup();
        expect((await addUser('Answer in Korean')) as any).toMatchObject({ success: false, code: 'memory_user_requires_human' });
        const r = await send('m1', 'p2p');
        expect(r).toMatchObject({ success: true, sent: true });
        expect(svc.inputLog.entries(SID).map((e) => [e.source, e.messageId])).toEqual([['human', 'm1']]);
        expect(await addUser('Answer in Korean')).toMatchObject({ success: true, result: 'applied' });
        expect(svc.memory.readFile('user').entries.length).toBe(1);
    });

    it('api, absent and non-dashboard sources are not human; other sessions are untouched', async () => {
        const { send } = setup();
        await send('a1', 'api');
        await send('a2', undefined);
        await send('a3', 'mesh');
        await send('a4', 'p2p', OTHER);
        expect(svc.inputLog.entries(SID)).toEqual([]);
        expect(svc.inputLog.has(OTHER)).toBe(false);
        expect(await addUser('x')).toMatchObject({ success: false, code: 'memory_user_requires_human' });
    });

    it('one entry per delivered message: a resend of the same id is a duplicate, not a second human input', async () => {
        const { send } = setup();
        await send('d1', 'standalone');
        const again = await send('d1', 'standalone');
        expect(again).toMatchObject({ deduplicated: true });
        expect(svc.inputLog.sources(SID)).toEqual(['human']);
    });

    it('a relay followed by a human: the review window is tainted, as before', async () => {
        const { send } = setup();
        svc.inputLog.append(SID, 'relay');
        svc.inputLog.closeTurn(SID);
        await send('h1', 'ws');
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'review', { messageId: 'review:1' });
        expect(svc.inputLog.writeContext(SID).origin).toBe('review_tainted');
    });

    it('a parked dashboard send is not logged until the drain writes it', async () => {
        const { send, parked } = setup(() => ({ status: 'queued', position: 1 }));
        const r = await send('q1', 'p2p');
        expect(r).toMatchObject({ queued: true });
        expect(svc.inputLog.entries(SID)).toEqual([]);
        expect(runtime!.relay.snapshot().pendingHuman).toBe(1);
        parked.delete('q1'); // drained
        expect(runtime!.relay.snapshot().pendingHuman).toBe(1);
    });
});

describe('relay: parked human inputs are logged at drain, in order', () => {
    function harness() {
        const log = new AssistantInputLog();
        const parked = new Set<string>();
        const submits: Array<{ text: string; messageId: string; policy: SendPolicy }> = [];
        let handler: (e: AssistantRelayBusEvent) => void = () => {};
        let outcome: SubmitOutcome = { kind: 'delivered' };
        const store = new InMemoryAssistantRelayStore();
        const relay = new AssistantRelay({
            subscribe: (h) => { handler = h; return () => {}; },
            coordinatorMeshOf: (s) => (s === 'coord' ? 'mesh_a' : null),
            projectSlug: () => 'blog',
            readCoordinatorTail: async () => 'done',
            meshWork: () => ({ activeMissions: 1, pending: 0, assigned: 1 }),
            hasAssistant: () => true,
            assistantSessionId: () => SID,
            isAssistantReady: () => true,
            isParked: async (_s, id) => parked.has(id),
            submit: async (_s, input) => { submits.push(input); return outcome; },
            inputLog: log,
            store,
        });
        relay.start();
        const turn = (phase: 'started' | 'committed', n: number, sessionId = SID) =>
            handler({ kind: 'turn', phase, sessionId, attemptId: `plain:${sessionId}:e${n}`, generation: 0, at: Date.now(), ...(phase === 'committed' ? { outcome: 'completed', strength: 'genuine' } : {}) } as AssistantRelayBusEvent);
        return { relay, log, parked, submits, turn, setOutcome: (o: SubmitOutcome) => { outcome = o; } };
    }

    it('logs each drained body once, in FIFO order, ahead of relays held behind it', async () => {
        const h = harness();
        h.relay.recordHumanSubmit([SID], 'h1', { kind: 'delivered' });
        h.relay.recordHumanSubmit([SID], 'h2', { kind: 'queued', position: 1 });
        h.relay.recordHumanSubmit([SID], 'h3', { kind: 'queued', position: 2 });
        h.relay.recordHumanSubmit([SID], 'h2', { kind: 'queued', position: 1 }); // re-report: no second pending entry
        h.parked.add('h2'); h.parked.add('h3');
        h.relay.enqueueInput({ source: 'relay', text: 'relay body', messageId: 'r1' });
        await h.relay.idle();
        expect(h.submits).toEqual([]); // held behind the parked human inputs
        h.turn('committed', 1);
        h.turn('started', 2); // a turn started, but h2 is still parked
        await h.relay.idle();
        expect(h.log.entries(SID).map((e) => e.messageId)).toEqual(['h1']);
        h.parked.delete('h2');
        h.turn('started', 3);
        await h.relay.idle();
        expect(h.log.entries(SID).map((e) => e.messageId)).toEqual(['h1', 'h2']);
        h.turn('committed', 3);
        h.parked.delete('h3');
        h.turn('started', 4);
        await h.relay.idle();
        h.turn('started', 4); // repeated edge: nothing pending, no double entry
        await h.relay.idle();
        // the held relay goes right after the last parked human input (this harness is always ready)
        expect(h.log.entries(SID).map((e) => [e.source, e.messageId])).toEqual([['human', 'h1'], ['human', 'h2'], ['human', 'h3'], ['relay', 'r1']]);
    });

    it('a parked body promoted by send_now is logged once, at the promotion', async () => {
        const h = harness();
        h.relay.recordHumanSubmit([SID], 'p1', { kind: 'queued', position: 1 });
        h.relay.recordHumanSubmit([SID], 'p1', { kind: 'delivered', route: 'agent_queue' });
        expect(h.relay.snapshot().pendingHuman).toBe(0);
        h.turn('started', 1);
        await h.relay.idle();
        expect(h.log.sources(SID)).toEqual(['human']);
    });

    it('refusals and duplicates are not logged; another session is ignored', () => {
        const h = harness();
        h.relay.recordHumanSubmit([SID], 'x1', { kind: 'refused', reason: 'modal_parked' });
        h.relay.recordHumanSubmit([SID], 'x2', { kind: 'duplicate', of: 'x2' });
        h.relay.recordHumanSubmit([OTHER], 'x3', { kind: 'delivered' });
        expect(h.log.has(SID)).toBe(false);
        expect(h.log.has(OTHER)).toBe(false);
    });
});
