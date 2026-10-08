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
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantMetricsStore } from '../../src/assistant/assistant-relay-sqlite-store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { buildAssistantRelayPorts, getAssistantRuntime, wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
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
        expect(subs.map((s) => s.name).sort()).toEqual(['assistant.registry', 'assistant.relay']);
        expect(hooks.isThreadOpen!('mesh_a')).toBe(true);
        runtime.activate('launch');
        expect(subs).toHaveLength(2);
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
