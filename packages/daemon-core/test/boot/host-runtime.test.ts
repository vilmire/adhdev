/**
 * createDaemonHostRuntime — the host surface both daemons share
 * (wiring-unification B5, design §B7 "host-runtime output-fanout gate +
 * providerLoader.watch() + completion-tail on working→ready").
 *
 * A real bus + registry + output fanout; everything else is a recording fake,
 * so each property is pinned without booting a daemon.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { SessionOutputFanout } from '../../src/boot/session-output-fanout.js';
import { InteractionContextMap } from '../../src/commands/interaction-context.js';
import { createDaemonHostRuntime, type DaemonHostTransport } from '../../src/boot/host-runtime.js';

function fakeRuntime() {
    const bus = createSessionLifecycleBus();
    const sessionRegistry = new SessionRegistry(bus);
    const instances = new Map<string, any>([
        ['cli-1', { category: 'cli', getPresentationMode: () => 'chat' }],
        ['cli-term', { category: 'cli', getPresentationMode: () => 'terminal' }],
        ['ide-1', { category: 'ide' }],
    ]);
    const instanceManager = {
        getInstance: (id: string) => instances.get(id),
        getSessionModalState: vi.fn((sessionId: string) => ({ id: sessionId, status: 'waiting_approval' })),
        collectAllStates: vi.fn(() => []),
    };
    const router = {
        execute: vi.fn(async (_cmd: string, _args: any, _source: string) => ({ success: true })),
        interactionContext: new InteractionContextMap(),
    };
    const createSnapshot = vi.fn(async () => ({}));
    const providerLoader = { watch: vi.fn(), getAll: () => [], resolve: () => null };
    const outputFanout = new SessionOutputFanout();
    const components = {
        bus,
        sessionRegistry,
        instanceManager,
        router,
        outputFanout,
        providerLoader,
        cdpManagers: new Map(),
        detectedIdes: { value: [] },
        commandHandler: { ctx: { gitCommandServices: { createSnapshot } } },
        cliManager: null,
        refreshProviderAvailability: vi.fn(async () => {}),
    };
    const runtime = { components, bus, seqscribe: null, shutdown: async () => {} } as any;
    return { runtime, bus, sessionRegistry, instanceManager, router, createSnapshot, providerLoader, outputFanout };
}

function fakeTransport(over: Partial<DaemonHostTransport> = {}) {
    const calls = {
        output: [] as Array<[string, string]>,
        statusFacts: [] as string[],
        flushActive: 0,
        flushCompleted: [] as string[][],
        statusEvents: [] as any[],
        meshState: [] as string[],
        commands: [] as string[],
    };
    const transport: DaemonHostTransport = {
        kind: 'standalone',
        instanceId: () => 'standalone_mach_t',
        version: 'test',
        topicSink: { send: () => true, isDeliverable: () => true, isAlive: () => true },
        chatTail: {
            flushDebounceMs: 700,
            scheduleGate: () => false,
            flushActive: () => { calls.flushActive += 1; },
            flushCompleted: (ids) => { calls.flushCompleted.push([...ids]); },
            readSource: 'standalone',
        },
        broadcastSessionOutput: (sessionId, data) => { calls.output.push([sessionId, data]); },
        sendStatusEvent: (payload) => { calls.statusEvents.push(payload); },
        onStatusFacts: (e) => { calls.statusFacts.push(e.kind); },
        onMeshState: (meshId) => { calls.meshState.push(meshId); },
        onCommandExecuted: (e) => { calls.commands.push(e.command); },
        ...over,
    };
    return { transport, calls };
}

const statusEdge = (sessionId: string, prev: any, next: any) => ({
    kind: 'status' as const, sessionId, at: 0, providerType: 'claude-cli', prev, next, cause: 'fsm_state' as const,
});

describe('createDaemonHostRuntime', () => {
    it('output fanout: only CLI sessions reach the transport, each marking chat-output activity; stop() detaches', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        const host = createDaemonHostRuntime(rt.runtime, transport);

        rt.outputFanout.broadcastSessionOutput('cli-1', 'hello');
        rt.outputFanout.broadcastSessionOutput('cli-term', 'raw');
        rt.outputFanout.broadcastSessionOutput('ide-1', 'nope');
        rt.outputFanout.broadcastSessionOutput('unknown', 'nope');
        expect(calls.output).toEqual([['cli-1', 'hello'], ['cli-term', 'raw']]);
        expect([...host.topics.getRecentlyOutputActiveChatSessionIds(Date.now())].sort()).toEqual(['cli-1', 'cli-term']);

        host.stop();
        rt.outputFanout.broadcastSessionOutput('cli-1', 'after stop');
        expect(calls.output).toHaveLength(2);
    });

    it('completion tail: working|blocked → ready forces a flush of that session; every edge hot-flushes', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        createDaemonHostRuntime(rt.runtime, transport);

        rt.bus.emit(statusEdge('s1', 'idle', 'generating'));
        expect(calls.flushCompleted).toEqual([]);
        rt.bus.emit(statusEdge('s1', 'generating', 'idle'));
        rt.bus.emit(statusEdge('s2', 'waiting_approval', 'idle'));
        rt.bus.emit(statusEdge('s3', 'generating', 'error'));
        expect(calls.flushCompleted).toEqual([['s1'], ['s2']]);
        expect(calls.flushActive).toBe(4);
        // The same edges are daemon facts for the host's status push.
        expect(calls.statusFacts).toEqual(['status', 'status', 'status', 'status']);
    });

    it('status facts: registered / terminated / daemon_facts reach onStatusFacts', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        createDaemonHostRuntime(rt.runtime, transport);
        rt.sessionRegistry.register({ sessionId: 's9', parentSessionId: null, providerType: 'claude-cli', transport: 'pty' } as any, 'launch');
        rt.sessionRegistry.terminate('s9', 'stop_requested');
        rt.bus.emit({ kind: 'daemon_facts', at: 0, cause: 'command' });
        expect(calls.statusFacts).toEqual(['registered', 'terminated', 'daemon_facts']);
    });

    it('execute: mints an interaction id, lets the transport refuse before the router, otherwise routes with the source', async () => {
        const rt = fakeRuntime();
        const admitted: string[] = [];
        const { transport } = fakeTransport({
            admit: (ctx) => {
                admitted.push(`${ctx.command}:${ctx.source}:${ctx.spec?.name ?? '-'}`);
                return ctx.command === 'launch_cli' ? { success: false, code: 'DAEMON_UPDATE_REQUIRED' } : null;
            },
        });
        const host = createDaemonHostRuntime(rt.runtime, transport);

        const refused = await host.execute('launch_cli', { cliType: 'codex' }, 'ipc');
        expect(refused).toMatchObject({ success: false, code: 'DAEMON_UPDATE_REQUIRED' });
        expect(refused.interactionId).toMatch(/^ix/);
        expect(rt.router.execute).not.toHaveBeenCalled();

        const routed = await host.execute('read_chat', { targetSessionId: 's1', _interactionId: 'ix_given' }, 'p2p', { peerId: 'peer-1' });
        expect(routed).toEqual({ success: true, interactionId: 'ix_given' });
        expect(rt.router.execute).toHaveBeenCalledWith('read_chat', { targetSessionId: 's1', _interactionId: 'ix_given' }, 'p2p', { peerId: 'peer-1' });
        // An unknown relay stamp is admitted and named `unknown` (the router logs it the same way).
        await host.execute('read_chat', {}, 'weird-relay');
        expect(admitted).toEqual(['launch_cli:ipc:launch_cli', 'read_chat:p2p:read_chat', 'read_chat:unknown:read_chat']);
    });

    it('command_executed: invalidates the topics (skipping daemon.metadata after a fast flush) then runs the host hook', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        const host = createDaemonHostRuntime(rt.runtime, transport);
        const invalidate = vi.spyOn(host.topics, 'invalidate').mockResolvedValue(undefined);
        const base = { kind: 'command_executed' as const, at: 0, source: 'ipc' as const, postChat: false, interactionId: 'i' };

        rt.bus.emit({ ...base, command: 'stop_cli', success: true, invalidates: new Set(['daemon.metadata'] as const), fastFlush: false });
        rt.bus.emit({ ...base, command: 'launch_cli', success: true, invalidates: new Set(['daemon.metadata'] as const), fastFlush: true });
        expect(invalidate.mock.calls).toEqual([
            [new Set(['daemon.metadata']), {}],
            [new Set(['daemon.metadata']), { skip: ['daemon.metadata'] }],
        ]);
        expect(calls.commands).toEqual(['stop_cli', 'launch_cli']);
    });

    it('modal / prompt edges flush session.modal; mesh_state runs the host hook and flushes daemon.metadata', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        const host = createDaemonHostRuntime(rt.runtime, transport);
        vi.spyOn(host.topics, 'hasSubscriptions').mockReturnValue(true);
        const flushNow = vi.spyOn(host.topics, 'flushNow').mockResolvedValue(undefined);

        rt.bus.emit({ kind: 'modal', sessionId: 's1', at: 0, modal: null });
        rt.bus.emit({ kind: 'prompt', sessionId: 's1', at: 0, prompt: null, transport: null });
        rt.bus.emit({ kind: 'mesh_state', at: 0, meshId: 'mesh_a' });
        expect(flushNow.mock.calls.map((c) => c[0])).toEqual(['session.modal', 'session.modal', 'daemon.metadata']);
        expect(calls.meshState).toEqual(['mesh_a']);
    });

    it('findSessionModalState uses the lightweight projection with the registry instanceKey, never collectAllStates', () => {
        const rt = fakeRuntime();
        const host = createDaemonHostRuntime(rt.runtime, fakeTransport().transport);
        rt.sessionRegistry.register({ sessionId: 'ext-1', parentSessionId: 'ide-1', providerType: 'cline', transport: 'cdp-webview', instanceKey: 'ide:cursor' } as any, 'attach');

        expect(host.findSessionModalState('ext-1')).toEqual({ id: 'ext-1', status: 'waiting_approval' });
        expect(rt.instanceManager.getSessionModalState).toHaveBeenCalledWith('ext-1', { instanceKey: 'ide:cursor' });
        expect(rt.instanceManager.collectAllStates).not.toHaveBeenCalled();
    });

    it('provider_event → the allow-listed status_event on the transport', () => {
        const rt = fakeRuntime();
        const { transport, calls } = fakeTransport();
        createDaemonHostRuntime(rt.runtime, transport);
        rt.bus.emit({ kind: 'provider_event', sessionId: 's1', at: 0, event: { event: 'agent:generating_completed', providerType: 'codex-cli', finalSummary: 'x' } as any });
        expect(calls.statusEvents).toHaveLength(1);
        expect(calls.statusEvents[0]).toMatchObject({ event: 'agent:generating_completed', providerType: 'codex-cli' });
        expect(calls.statusEvents[0]).not.toHaveProperty('finalSummary');
    });

    it('D4: a turn ending in a known workspace takes the after_agent_work snapshot', () => {
        const rt = fakeRuntime();
        createDaemonHostRuntime(rt.runtime, fakeTransport().transport);
        rt.sessionRegistry.register({ sessionId: 's1', parentSessionId: null, providerType: 'claude-cli', transport: 'pty', workspace: '/repo' } as any, 'launch');
        rt.bus.emit(statusEdge('s1', 'generating', 'idle'));
        rt.bus.emit(statusEdge('s1', 'idle', 'generating'));
        expect(rt.createSnapshot).toHaveBeenCalledTimes(1);
        expect(rt.createSnapshot).toHaveBeenCalledWith({ workspace: '/repo', reason: 'after_agent_work', sessionId: 's1' });
    });

    it('P-II item 1: topic flushes are edge-driven only — no background interval fires extra flushes', () => {
        vi.useFakeTimers();
        try {
            const rt = fakeRuntime();
            const { transport, calls } = fakeTransport();
            const host = createDaemonHostRuntime(rt.runtime, transport);
            vi.spyOn(host.topics, 'hasSubscriptions').mockReturnValue(true);
            const flushNow = vi.spyOn(host.topics, 'flushNow').mockResolvedValue(undefined);
            const invalidate = vi.spyOn(host.topics, 'invalidate').mockResolvedValue(undefined);

            // N = 3 modal/prompt edges → exactly 3 session.modal flushNow calls.
            rt.bus.emit({ kind: 'modal', sessionId: 's1', at: 0, modal: null });
            rt.bus.emit({ kind: 'prompt', sessionId: 's1', at: 0, prompt: null, transport: null });
            rt.bus.emit({ kind: 'mesh_state', at: 0, meshId: 'mesh_a' });
            expect(flushNow.mock.calls.map((c) => c[0])).toEqual(['session.modal', 'session.modal', 'daemon.metadata']);
            expect(invalidate).not.toHaveBeenCalled();

            // Advancing well past several 2-2.5s legacy-timer periods AND the 60s
            // reconciliation period must not add a single extra flush/invalidate
            // call — the reconciliation tick only WARNs, it never flushes.
            vi.advanceTimersByTime(180_000);
            expect(flushNow).toHaveBeenCalledTimes(3);
            expect(invalidate).not.toHaveBeenCalled();
            expect(calls.commands).toEqual([]);

            host.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('startDevSupport starts the DevServer and turns on provider hot reload (providerLoader.watch)', async () => {
        const rt = fakeRuntime();
        const host = createDaemonHostRuntime(rt.runtime, fakeTransport().transport);
        const facts: string[] = [];
        rt.bus.on('daemon_facts', (e) => { facts.push(e.cause); });

        const devServer = await host.startDevSupport({ port: 0, logFn: () => {} });
        try {
            expect(rt.providerLoader.watch).toHaveBeenCalledTimes(1);
            await devServer.onProviderSourceConfigChanged?.();
            expect(facts).toEqual(['provider_settings']);
        } finally {
            devServer.stop();
        }
    });
});
