import { reportMessageId } from '../../src/assistant/project-views.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildAssistantRelayPorts } from '../../src/assistant/assistant-runtime.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests } from '../../src/assistant/assistant-project-ports.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { renderNativeReplies } from '../../src/assistant/assistant-native-window.js';

const registryFixture = vi.hoisted(() => ({ local: ['coord', 'unauthorized'], remote: ['remote-coord'] }));
vi.mock('../../src/mesh/coordinator-registry.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/mesh/coordinator-registry.js')>(),
    listCoordinatorsForMesh: (meshId: string) => (meshId === 'local' ? registryFixture.local : registryFixture.remote)
        .map(sessionId => ({ sessionId, meshId, cliType: 'codex-cli' })),
}));

const NOW = Date.parse('2026-10-17T07:00:00Z');
let dir: string;
let db: Database.Database;
let remoteReply: any;
let execute: ReturnType<typeof vi.fn>;
let project: any;
function ports() {
    return buildAssistantRelayPorts({ bus: { on: () => () => {} }, instanceManager: { getInstance: () => null },
        router: { execute }, cliManager: {} } as any, { registry: new AssistantRegistry({ configDir: dir }),
        store: new InMemoryAssistantRelayStore(), metrics: null, sawCaller: () => true });
}
function reference(generation = 0, marker = 'verified-native-window:' + createHash('sha256').update(JSON.stringify([
    { at: NOW - 5_000, chars: 6, text: 'report' },
])).digest('hex')) {
    return JSON.stringify([2, generation, NOW - 1_000, 'terminal', 'a'.repeat(64), 'terminal', 'b'.repeat(64), marker]);
}
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    dir = mkdtempSync(join(tmpdir(), 'relay-runtime-evidence-'));
    db = new Database(':memory:'); ensureAssistantRelaySchema(db); ensureTurnLedgerSchema(db);
    vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db } as any);
    registryFixture.local = ['coord', 'unauthorized']; registryFixture.remote = ['remote-coord'];
    execute = vi.fn(async () => ({ success: true, coverage: 'full', debugReadChat: { provider: 'codex-cli' }, messageSource: { selected: 'native-history' },
        messages: [{ role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp: NOW - 5_000, content: 'native reply' }] }));
    project = { listMeshes: () => [{ id: 'local' }, { id: 'remote' }], isHostedHere: (m: any) => m.id === 'local',
        coordinatorSessionAuthorized: (_mesh: string, sessionId: string) => sessionId !== 'unauthorized',
        remoteHost: () => ({ reachable: true }), callHost: async () => ({ ok: true, result: { result: remoteReply } }),
    };
    setAssistantProjectPortsForTests(() => project);
    setAssistantServicesForTests(createAssistantServices({ configDir: dir, listMeshes: project.listMeshes }));
    remoteReply = { body: 'report', completeness: 'final_native', source: 'native_window', parts: [{ at: NOW - 5_000, chars: 6 }],
        provenance: { version: 2, attemptId: 'plain:a', coordinatorSessionId: 'remote-coord', generation: 0, evidenceRef: reference() } };
});
afterEach(() => {
    setAssistantProjectPortsForTests(null); setAssistantServicesForTests(null); vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers();
});

describe('runtime native relay evidence wiring', () => {
    it('audits authenticated hosted coordinators with no attempt, excluding private and remote sessions', async () => {
        db.prepare(`INSERT INTO turn_attempts(attempt_id,scope,session_id,owner_daemon_id,state,accepted_at,terminal_at,created_at,updated_at)
            VALUES('private','plain','private-owner-chat','host','completed',?,?,?,?)`).run(NOW - 10_000, NOW - 5_000, NOW - 10_000, NOW);
        const replies = await ports().auditCoordinatorReplies!(NOW - 60_000);
        expect(replies.map(r => [r.sessionId, r.attemptId])).toEqual([['coord', null]]);
        expect(execute.mock.calls).toHaveLength(1);
        expect(execute).toHaveBeenCalledWith('read_chat', { targetSessionId: 'coord', tailLimit: 200 }, 'ipc', { inProcess: true });
    });

    it('propagates failed scans instead of returning a successful empty result', async () => {
        execute.mockResolvedValue({ success: false } as any);
        await expect(ports().auditCoordinatorReplies!(NOW)).rejects.toThrow('coordinator native audit unavailable');
    });

    it('preserves partial scan status while returning healthy observations', async () => {
        registryFixture.local = ['coord', 'offline'];
        execute.mockImplementation(async (_cmd: string, args: any) => args.targetSessionId === 'offline' ? { success: false } : ({
            success: true, coverage: 'full', debugReadChat: { provider: 'codex-cli' }, messageSource: { selected: 'native-history' },
            messages: [{ role: 'assistant', kind: 'standard', bubbleState: 'final', timestamp: NOW - 5_000, content: 'native reply' }],
        }) as any);
        const replies = await ports().auditCoordinatorReplies!(NOW);
        expect(replies.complete).toBe(false);
        expect(replies.map(r => r.sessionId)).toEqual(['coord']);
    });

    it.each(['leading whitespace', 'trailing whitespace', 'both'])('real readability predicate accepts %s without comparing raw and trimmed lengths', async variant => {
        const body = (variant !== 'trailing whitespace' ? ' \n ' : '') + 'Synthetic final message. Second sentence.' + (variant !== 'leading whitespace' ? ' \n ' : '');
        const message = { role: 'assistant', kind: 'standard', receivedAt: NOW - 5_000, content: body };
        project.execute = execute;
        execute.mockResolvedValue({ success: true, messages: [message], hasMore: false } as any);
        const audited = { sessionId: 'coord', meshId: 'local', attemptId: 'plain:a', messageAt: message.receivedAt,
            text: body.trim(), chars: body.trim().length, messageId: reportMessageId(message) };
        expect(await ports().canReadCoordinatorReply!(audited)).toBe(true);
        expect(await ports().canReadCoordinatorReply!({ ...audited, messageId: 'f'.repeat(64) })).toBe(false);
    });

    it('finds a real readable context cursor for an unsupported timestamp provider without promoting its finality', async () => {
        const message = { role: 'assistant', kind: 'standard', receivedAt: NOW - 5_000, content: 'Synthetic unsupported-provider context.' };
        project.execute = execute;
        execute.mockResolvedValue({ success: true, agent: 'grok-cli', source: 'provider-native', messages: [message] } as any);
        expect(await ports().readCoordinatorReference!('local', 'coord')).toEqual({ coordinatorSessionId: 'coord', messageId: reportMessageId(message), offset: 0 });
    });

    it('binds remote fallback context to the already known coordinator session', async () => {
        remoteReply = { coordinatorSessionId: 'remote-coord', messages: [{ role: 'assistant', messageId: 'e'.repeat(64) }] };
        expect(await ports().readCoordinatorReference!('remote', 'remote-coord')).toEqual({ coordinatorSessionId: 'remote-coord', messageId: 'e'.repeat(64), offset: 0 });
        remoteReply.coordinatorSessionId = 'foreign';
        expect(await ports().readCoordinatorReference!('remote', 'remote-coord')).toBeNull();
    });

    it('accepts a newer host with verified native provenance', async () => {
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toMatchObject({ body: 'report', completeness: 'final_native' });
    });

    it('accepts a digest bound to all replies in a native multi-reply body', async () => {
        const bubbles = [{ at: NOW - 6_000, chars: 5, text: 'first' }, { at: NOW - 5_000, chars: 4, text: 'last' }];
        remoteReply.body = renderNativeReplies(bubbles);
        remoteReply.parts = bubbles.map(({ at, chars }) => ({ at, chars }));
        remoteReply.provenance.evidenceRef = reference(0, 'verified-native-window:' + createHash('sha256').update(JSON.stringify(bubbles)).digest('hex'));
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toMatchObject({ body: remoteReply.body, parts: remoteReply.parts, completeness: 'final_native' });
    });

    it.each(['old v2', 'v1', 'missing completeness', 'wrong generation', 'malformed reference'])('keeps %s remote evidence unverified', async defect => {
        if (defect === 'old v2') remoteReply.provenance.evidenceRef = reference(0, 'old-parts-hash');
        if (defect === 'v1') remoteReply.provenance.version = 1;
        if (defect === 'missing completeness') delete remoteReply.completeness;
        if (defect === 'wrong generation') remoteReply.provenance.evidenceRef = reference(1);
        if (defect === 'malformed reference') remoteReply.provenance.evidenceRef = 'not-json';
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toMatchObject({ body: 'report', completeness: 'envelope_unverified' });
    });

    it('does not relax foreign attempt/session proof checks', async () => {
        remoteReply.provenance.attemptId = 'foreign';
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toBeNull();
        remoteReply.provenance.attemptId = 'plain:a'; remoteReply.provenance.coordinatorSessionId = 'foreign';
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toBeNull();
    });

    it.each(['changed body', 'changed part', 'missing parts'])('does not trust a native marker with %s', async defect => {
        if (defect === 'changed body') remoteReply.body = 'changed';
        if (defect === 'changed part') remoteReply.parts[0].at -= 1;
        if (defect === 'missing parts') delete remoteReply.parts;
        expect(await ports().rehydrateAttemptReport!('remote', 'remote-coord', 'plain:a')).toMatchObject({ completeness: 'envelope_unverified' });
    });
});
