/**
 * Assistant boot wiring (assistant/assistant-runtime.ts; design
 * 2026-10-07-assistant-layer.md §4.3, §4.5): inert until an assistant exists,
 * activation subscribes the registry + relay and is idempotent, the port
 * adapters map onto the daemon (coordinator mark, read_chat tail, ready
 * check, send funnel with origin 'assistant'), delivery feeds the registry
 * and metrics, and dispose clears hooks and subscriptions in reverse.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { recoverAttemptReport } from '../../src/assistant/attempt-report-recovery.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantMetricsStore, SqliteAssistantRelayStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { buildAssistantRelayPorts, getAssistantRuntime, wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { TerminalWatchStore } from '../../src/assistant/terminal-watch.js';
import { memDb, ledgerOn, dispatch, evd } from '../turn-ledger/ledger-harness.js';
import { setAssistantProjectPortsForTests } from '../../src/assistant/assistant-project-ports.js';
import { createDefaultProjectPorts, preloadAssistantProjectReaders } from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, getAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { REVIEW_INPUT_TEXT } from '../../src/assistant/assistant-review.js';

let dir: string;
let registry: AssistantRegistry;
let subs: Array<{ name: string; kinds: unknown; off: ReturnType<typeof vi.fn> }>;
let instances: Record<string, any>;
let submits: any[];
let runtime: AssistantRuntime | null;
let routerExecute: ReturnType<typeof vi.fn>;

function components() {
    return {
        bus: {
            on: (kinds: unknown, _h: unknown, opts?: { name?: string }) => {
                const off = vi.fn();
                subs.push({ name: opts?.name ?? '?', kinds, off });
                return off;
            },
        },
        instanceManager: { getInstance: (id: string) => instances[id] },
        router: { execute: routerExecute },
        cliManager: { input: { submit: async (m: any) => { submits.push(m); return { kind: 'queued', position: 1 }; } } },
    } as any;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-runtime-'));
    registry = new AssistantRegistry({ configDir: dir });
    subs = [];
    instances = {};
    submits = [];
    runtime = null;
    routerExecute = vi.fn(async () => ({
        success: true,
        messages: [
            { role: 'user', content: 'do it' },
            { role: 'assistant', content: 'first answer' },
            { role: 'assistant', kind: 'tool', content: 'tool noise' },
            { role: 'assistant', content: 'final answer' },
            { role: 'user', content: 'later human line' },
        ],
    }));
    setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: () => [{ id: 'mesh_a', name: 'Blog', repoIdentity: 'github.com/o/blog', nodes: [] } as any] }));
});

afterEach(() => {
    runtime?.dispose();
    setAssistantServicesForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe('wireAssistantRuntime', () => {
    it('is inert without an assistant; the first project_send activates once', async () => {
        runtime = wireAssistantRuntime(components(), { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000 });
        expect(getAssistantRuntime()).toBe(runtime);
        expect(runtime.isActive()).toBe(false);
        expect(subs).toEqual([]);
        await preloadAssistantProjectReaders();
        const hooks = createDefaultProjectPorts({ components: () => components(), execute: async () => ({ success: true }), selfDaemonId: 'd' }).relay;
        hooks.openThread!('mesh_a');
        expect(runtime.isActive()).toBe(true);
        // assistant.context: saves the last exchanges after each finished turn (previous-session note).
        expect(subs.map((s) => s.name).sort()).toEqual(['assistant.context', 'assistant.registry', 'assistant.relay']);
        expect(hooks.isThreadOpen!('mesh_a')).toBe(true);
        runtime.activate('launch');
        expect(subs).toHaveLength(3);
    });

    it('authenticates MCP-only read acknowledgements with the same non-null pull caller', async () => {
        runtime = wireAssistantRuntime(components(), { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000 });
        await preloadAssistantProjectReaders();
        const hooks = createDefaultProjectPorts({ components: () => components(), execute: async () => ({ success: true }), selfDaemonId: 'd' }).relay;
        const ack = vi.spyOn(runtime.relay, 'recordProjectRead');
        const result = { coordinatorSessionId: 'coord', messages: [] };
        hooks.recordProjectRead!(result, 'foreign'); expect(ack).not.toHaveBeenCalled();
        await runtime.pull('mcp-assistant');
        expect(hooks.assistantSessionId!()).toBe('mcp-assistant');
        hooks.recordProjectRead!(result, 'mcp-assistant');
        expect(ack).toHaveBeenCalledWith(result, 'mcp-assistant');
        ack.mockClear(); hooks.recordProjectRead!(result, 'foreign'); expect(ack).not.toHaveBeenCalled();
    });

    it('activates at wire time when assistant.json has an entry; dispose unsubscribes and clears hooks', async () => {
        registry.bindSession({ sessionId: 'asst', cliType: 'claude-cli', workspace: dir, at: 1 });
        runtime = wireAssistantRuntime(components(), { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000 });
        expect(runtime.isActive()).toBe(true);
        runtime.dispose();
        expect(subs.every((s) => s.off.mock.calls.length === 1)).toBe(true);
        expect(getAssistantRuntime()).toBeNull();
        await preloadAssistantProjectReaders();
        const hooks = createDefaultProjectPorts({ components: () => components(), execute: async () => ({ success: true }), selfDaemonId: 'd' }).relay;
        expect(hooks.openThread).toBeUndefined();
        runtime = null;
    });

    it('reads the review-turn quota for the bound assistant CLI through the quota port', () => {
        const seen: string[] = [];
        const quota = { remainingPct: (cliType: string) => (seen.push(cliType), 42) };
        runtime = wireAssistantRuntime(components(), { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000, quota });
        expect(runtime.reviewQuotaRemainingPct(1)).toBeNull(); // no assistant bound
        registry.bindSession({ sessionId: 'asst', cliType: 'codex-cli', workspace: dir, at: 1 });
        expect(runtime.reviewQuotaRemainingPct(1)).toBe(42);
        expect(seen).toEqual(['codex-cli']);
        runtime.dispose();
        runtime = null;
    });

    it('the relay tick queues the idle review turn into the live assistant, records it and bumps review_turns', async () => {
        const t0 = Date.parse('2026-10-08T09:00:00Z');
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
            vi.setSystemTime(t0);
            registry.bindSession({ sessionId: 'asst', cliType: 'claude-cli', workspace: dir, at: t0 });
            instances.asst = { getState: () => ({ status: 'idle', activeChat: null }), isModalParked: () => false };
            const db = new Database(':memory:');
            ensureAssistantRelaySchema(db);
            const metrics = new AssistantMetricsStore(db);
            const log = getAssistantServices().inputLog;
            log.begin('asst');
            for (let i = 0; i < 6; i++) { log.append('asst', 'human', { at: t0 }); log.closeTurn('asst'); }
            runtime = wireAssistantRuntime(components(), {
                registry, store: new InMemoryAssistantRelayStore(), metrics, tickMs: 60_000, quota: { remainingPct: () => 50 },
            });
            vi.advanceTimersByTime(9 * 60_000);
            expect(submits).toEqual([]); // idle 9 min < 10 min
            vi.advanceTimersByTime(2 * 60_000);
            await runtime.relay.idle();
            expect(submits).toHaveLength(1);
            expect(submits[0]).toMatchObject({ sessionId: 'asst', origin: 'assistant', policy: { mode: 'queue' } });
            expect(submits[0].input.textFallback).toBe(REVIEW_INPUT_TEXT);
            expect(log.sources('asst').at(-1)).toBe('review');
            expect(registry.read()!.reviewAts).toHaveLength(1);
            expect(metrics.rows().find((r) => r.meshId === '')?.review_turns).toBe(1);
            vi.advanceTimersByTime(30 * 60_000);
            await runtime.relay.idle();
            expect(submits).toHaveLength(1); // review turn still open → in flight, no second review
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('buildAssistantRelayPorts', () => {
  it('readCoordinatorTail bypasses compactTranscriptTail 4000 char limit to preserve explicit truncation markers', async () => {
    const deps = components();
    const p = buildAssistantRelayPorts(deps, { registry, store: new InMemoryAssistantRelayStore(), metrics: null, sawCaller: () => false });
    const longText = 'A'.repeat(5000);
    vi.mocked(deps.router.execute).mockResolvedValueOnce({
      success: true,
      messages: [{ role: 'assistant', text: longText }]
    });

    const tail = await p.readCoordinatorTail('session-1');
    expect(tail).toBe(longText);
    expect(tail?.length).toBe(5000); // Must return the raw long text without 4000 char slice
  });

  it('readCoordinatorTail skips tool and non-userVisible bubbles', async () => {
      const deps = components();
      const p = buildAssistantRelayPorts(deps, { registry, store: new InMemoryAssistantRelayStore(), metrics: null, sawCaller: () => false });
      vi.mocked(deps.router.execute).mockResolvedValueOnce({
          success: true,
          messages: [
              { role: 'assistant', text: 'visible answer' },
              { role: 'assistant', kind: 'tool', text: 'tool noise' },
              { role: 'assistant', meta: { userVisible: false }, text: 'hidden noise' }
          ]
      });
      const tail = await p.readCoordinatorTail('session-1');
      expect(tail).toBe('visible answer');
  });

  it('readCoordinatorTail finds role agent', async () => {
      const deps = components();
      const p = buildAssistantRelayPorts(deps, { registry, store: new InMemoryAssistantRelayStore(), metrics: null, sawCaller: () => false });
      vi.mocked(deps.router.execute).mockResolvedValueOnce({
          success: true,
          messages: [
              { role: 'agent', text: 'agent answer' }
          ]
      });
      const tail = await p.readCoordinatorTail('session-1');
      expect(tail).toBe('agent answer');
  });

    function ports(metrics: AssistantMetricsStore | null = null) {
        return buildAssistantRelayPorts(components(), { registry, store: new InMemoryAssistantRelayStore(), metrics, sawCaller: () => false });
    }

    it('maps coordinator mark, readiness and project slug', () => {
        instances.coord = { getState: () => ({ status: 'generating', settings: { meshCoordinatorFor: 'mesh_a' } }) };
        instances.asst = { getState: () => ({ status: 'idle', settings: {} }) };
        instances.modal = { getState: () => ({ status: 'idle' }), isModalParked: () => true };
        const p = ports();
        expect(p.coordinatorMeshOf('coord')).toBe('mesh_a');
        expect(p.coordinatorMeshOf('nope')).toBeNull();
        expect(p.isAssistantReady('asst')).toBe(true);
        expect(p.isAssistantReady('coord')).toBe(false);
        expect(p.isAssistantReady('modal')).toBe(false);
        expect(p.isAssistantReady('gone')).toBe(false);
        expect(p.projectSlug('mesh_a')).toBe('blog');
        expect(p.projectSlug('mesh_x')).toBeNull();
        expect(p.hasAssistant()).toBe(false);
    });

    it('reads the latest visible assistant bubble through read_chat in-process', async () => {
        expect(await ports().readCoordinatorTail('coord')).toBe('final answer');
        expect(routerExecute).toHaveBeenCalledWith('read_chat', { targetSessionId: 'coord', limit: 40 }, 'ipc', { inProcess: true });
        routerExecute.mockResolvedValueOnce({ success: false });
        expect(await ports().readCoordinatorTail('coord')).toBeNull();
    });

    it('submits through the send funnel with origin assistant and the given policy', async () => {
        const outcome = await ports().submit('asst', { text: 'hi', messageId: 'relay:m:1', policy: { mode: 'queue' } });
        expect(outcome).toEqual({ kind: 'queued', position: 1 });
        expect(submits[0]).toMatchObject({
            messageId: 'relay:m:1', sessionId: 'asst', origin: 'assistant', policy: { mode: 'queue' },
            input: { parts: [{ type: 'text', text: 'hi' }], textFallback: 'hi' },
        });
    });

    it('delivery marks firstRelayAt once and counts relays per mesh', () => {
        registry.bindSession({ sessionId: 'asst', cliType: 'claude-cli', workspace: dir, at: 1 });
        const db = new Database(':memory:');
        ensureAssistantRelaySchema(db);
        const metrics = new AssistantMetricsStore(db);
        const p = ports(metrics);
        const at = Date.parse('2026-10-07T12:00:00Z');
        p.onRelayDelivered!(['mesh_a', 'mesh_b'], at);
        p.onRelayDelivered!(['mesh_a'], at + 10);
        expect(registry.read()?.firstRelayAt).toBe(at);
        expect(metrics.rows().map((r) => [r.meshId, r.relays])).toEqual([['mesh_a', 2], ['mesh_b', 1]]);
        expect(p.hasAssistant()).toBe(true);
    });
});

it('real runtime relay delivers recreation uncertainty once and resumes ordered reducer terminals only after explicit retry and native receipts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const db = memDb(); const ledger = ledgerOn(db);
    try {
        vi.setSystemTime(Date.parse('2026-10-12T07:00:00Z'));
        for (let i = 0; i < 2; i++) {
            const attemptId = `attempt-${i}`;
            ledger.observe({ ...dispatch({ meshId: 'mesh_a', attemptId }), messageId: `msg-${i}`, attemptNo: i } as any);
            ledger.observe(evd('turn_started', { retro: false }, { attemptRef: { attemptId, generation: 0 } }));
            ledger.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: { attemptId, generation: 0 } }));
        }
        const store = new TerminalWatchStore(db); const sub: any = store.subscribe('mesh_a', 'task', 't1', 'assistant');
        store.beginDelivery(sub.watchId, 'attempt-0#committed', 'old-assistant');
        vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db } as any);
        setAssistantProjectPortsForTests(() => ({ listMeshes: () => [{ id: 'mesh_a' }], isHostedHere: () => true,
            execute: async () => { throw Error('original session unavailable'); } }) as any);
        registry.bindSession({ sessionId: 'new-assistant', cliType: 'claude-cli', workspace: dir });
        registry.updateSettings({ reviewTurn: false });
        instances['new-assistant'] = { getState: () => ({ status: 'idle' }) };
        const deps = components();
        deps.cliManager.input.submit = async (input: any) => { submits.push(input); return { kind: 'delivered' }; };
        runtime = wireAssistantRuntime(deps, { registry, store: new InMemoryAssistantRelayStore(), metrics: null });
        await vi.advanceTimersByTimeAsync(60_000); await runtime.relay.idle();
        expect(submits).toHaveLength(1); expect(submits[0].sessionId).toBe('new-assistant');
        expect(submits[0].input.textFallback).toContain('unconfirmed_original_recipient');
        expect(submits[0].input.textFallback).toContain('"project":"mesh_a"');
        expect(store.receipts(sub.watchId)).toEqual([]);
        await vi.advanceTimersByTimeAsync(120_000); await runtime.relay.idle();
        expect(submits).toHaveLength(1); // actual native enqueue returns pending for terminals, accepted for metadata
        store.retryDelivery(sub.watchId, 'attempt-0#committed');
        await vi.advanceTimersByTimeAsync(60_000); await runtime.relay.idle();
        expect(store.receipts(sub.watchId)).toEqual(['attempt-0#committed']);
        await vi.advanceTimersByTimeAsync(60_000); await runtime.relay.idle();
        expect(store.receipts(sub.watchId)).toEqual(['attempt-0#committed','attempt-1#committed']);
        expect(submits).toHaveLength(3); expect(getAssistantServices().inputLog.sources('new-assistant').at(-1)).toBe('relay');
    } finally {
        runtime?.dispose(); runtime = null; setAssistantProjectPortsForTests(null); vi.restoreAllMocks(); vi.useRealTimers(); db.close();
    }
});

it('actual runtime exact-reader port validates terminal/generation before durable capture and enforces session authorization', async () => {
    const db = memDb(); ensureAssistantRelaySchema(db);
    const ledger = ledgerOn(db);
    const started = ledger.observe(evd('turn_started', { retro: false }, { eventId: 'plain-start', at: 100, attemptRef: undefined, sessionId: 'coord' })).attempt!;
    const attempt = ledger.observe(evd('transcript_final', { selfAttributing: true, nativeRead: true,
        live: { modal: false, adapterPending: false, trailingTool: false }, messageAt: 190 },
        { eventId: 'end', at: 200, sessionId: 'coord', attemptRef: { attemptId: started.attemptId, generation: started.generation } })).attempt!;
    const generation = attempt.generation;
    const store = new SqliteAssistantRelayStore(db);
    store.recordCommitted({ attemptId: attempt.attemptId, meshId: 'mesh_a', coordinatorSessionId: 'coord', committedAt: Date.now(), kind: 'relay', outcome: 'completed' });
    const spy = vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db, turnStore: () => ({ getAttempt: (id: string) => id === attempt.attemptId ? attempt : null }) } as any);
    routerExecute.mockResolvedValue({ success: true, coverage: 'full', messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' },
        messages: [{ role: 'assistant', bubbleState: 'final', timestamp: 190, content: 'exact report' }, { role: 'assistant', bubbleState: 'final', timestamp: 10_000, content: 'newer tail' }] });
    let hostedHere = true; let remoteReply: any = { body: 'unproven old-host tail', source: 'durable_attempt_capture' };
    setAssistantProjectPortsForTests(() => ({ listMeshes: () => [{ id: 'mesh_a' }], isHostedHere: () => hostedHere,
        remoteHost: () => ({ reachable: true }), callHost: async () => ({ ok: true, result: { result: remoteReply } }),
        coordinatorSessionAuthorized: (mesh: string, sid: string) => mesh === 'mesh_a' && sid === 'coord',
        execute: routerExecute }) as any);
    try {
        const port = buildAssistantRelayPorts(components(), { registry, store, metrics: null, sawCaller: () => false });
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toMatchObject({ body: 'exact report', completeness: 'final_native' });
        routerExecute.mockClear(); routerExecute.mockResolvedValue({ success: true, messages: [{ role: 'assistant', timestamp: 10_000, content: 'newest tail' }] });
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toMatchObject({ body: 'exact report', completeness: 'final_native', source: 'durable_attempt_capture' });
        expect(await port.rehydrateAttemptReport!('mesh_a', 'foreign', attempt.attemptId)).toBeNull();
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', 'missing')).toBeNull();
        routerExecute.mockClear();
        attempt.generation = generation + 1;
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toBeNull();
        expect(routerExecute).not.toHaveBeenCalled();
        attempt.generation = generation; hostedHere = false;
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toBeNull();
        remoteReply = await recoverAttemptReport(db, attempt, 'mesh_a', 'coord', routerExecute);
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toMatchObject({ body: 'exact report', completeness: 'final_native' });
        remoteReply = { ...remoteReply, provenance: { ...remoteReply.provenance, version: 1 } };
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toMatchObject({ body: 'exact report', completeness: 'envelope_unverified' });
        remoteReply = { ...remoteReply, provenance: { ...remoteReply.provenance, version: 2 } };
        remoteReply = { ...remoteReply, provenance: { ...remoteReply.provenance, attemptId: 'foreign' } };
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toBeNull();
        remoteReply.provenance = { ...remoteReply.provenance, attemptId: attempt.attemptId, coordinatorSessionId: 'foreign' };
        expect(await port.rehydrateAttemptReport!('mesh_a', 'coord', attempt.attemptId)).toBeNull();
    } finally { setAssistantProjectPortsForTests(null); spy.mockRestore(); db.close(); }
});
