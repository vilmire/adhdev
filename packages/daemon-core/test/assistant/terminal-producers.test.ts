import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { assistantWatchSpecs } from '../../src/commands/high-family/assistant-watch.js';
import { terminalRetryIdentity } from '../../src/assistant/terminal-watch.js';
import { afterEach, expect, it, vi } from 'vitest';
import { memDb, ledgerOn, dispatch, evd, T0, confirmFixtureWriterQuiescence } from '../turn-ledger/ledger-harness.js';
import { LocalRecordStore } from '../../src/mesh/mesh-local-record-store.js';
import { readTerminalEvents, TerminalWatchStore } from '../../src/assistant/terminal-watch.js';
import { pendingTerminalEvents } from '../../src/assistant/terminal-watch-runtime.js';
import { assistantRemoteHandlers } from '../../src/commands/high-family/assistant-remote.js';
import { setAssistantProjectPortsForTests } from '../../src/assistant/assistant-project-ports.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { markVerifiedMeshSender } from '../../src/commands/mesh-sender.js';
const dbs: ReturnType<typeof memDb>[] = [];
afterEach(() => { vi.restoreAllMocks(); setAssistantProjectPortsForTests(null); dbs.splice(0).forEach(db => db.close()); });
function producer(scope: 'mesh_queue' | 'mesh_direct', end: 'genuine' | 'weak' | 'failed' | 'cancelled') {
    const db = memDb(); dbs.push(db); const ledger = ledgerOn(db);
    ledger.observe(dispatch({ scope }));
    ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
    ledger.observe(evd('turn_started', { retro: false }));
    if (end === 'failed') ledger.observe(evd('turn_end', { strength: 'genuine', providerFailure: 'auth_failed' }));
    else if (end === 'cancelled') ledger.observe(evd('cancel', { reason: 'operator_cancel' }, { source: 'operator' } as any));
    else {
        ledger.observe(evd('turn_end', { strength: end }));
        if (end === 'weak') ledger.observe(evd('turn_end', { strength: 'weak', afterFinalizationTimeout: true }));
    }
    return { db, ledger };
}
it.each(['mesh_queue', 'mesh_direct'] as const)('reads real %s reducer commits and exposes genuine/weak/failure/cancel truth without bodies', async scope => {
    for (const end of ['genuine','weak','failed','cancelled'] as const) {
        const { db, ledger } = producer(scope, end);
        if (end === 'cancelled') {
            expect(ledger.getAttempt('a1')).toMatchObject({ state: 'stopping', terminal: null, generation: 0 });
            expect(readTerminalEvents(db, 'm1', 'task', 't1', 0, [])).toEqual([]);
            await confirmFixtureWriterQuiescence(ledger);
        }
        const terminal = ledger.getAttempt('a1')?.terminal;
        expect(terminal).not.toBeNull();
        const events = readTerminalEvents(db, 'm1', 'task', 't1', 0, []);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ eventId: 'a1#committed', attemptId: 'a1', outcome: terminal!.outcome, strength: terminal!.strength,
            evidenceLevel: end === 'weak' ? 'weak' : 'strong', sessionId: 's1', nodeId: 'n1' });
        expect(readTerminalEvents(db, 'm1', 'task', 't1', 0, ['a1#committed'])).toEqual([]);
        expect(JSON.stringify(events)).not.toContain('summary');
    }
});
it('weak uncommitted evidence does not appear; migration duplicates and old receipts cannot redeliver a committed attempt', () => {
    const { db, ledger } = producer('mesh_direct', 'genuine');
    const records = new LocalRecordStore(db);
    records.insert({ eventId: 'legacy', meshId: 'm1', kind: 'task_completed', taskId: 't1', sessionId: 's1', nodeId: 'n1', atMs: T0, payload: { attemptId: 'a1', secret: 'report body' } });
    expect(readTerminalEvents(db, 'm1', 'task', 't1', 0, []).map(e => e.eventId)).toEqual(['a1#committed']);
    expect(readTerminalEvents(db, 'm1', 'task', 't1', 0, ['legacy'])).toEqual([]);
    const fresh = memDb(); dbs.push(fresh); const open = ledgerOn(fresh);
    open.observe(dispatch()); open.observe(evd('turn_started', { retro: false })); open.observe(evd('turn_end', { strength: 'weak' }));
    expect(open.getAttempt('a1')?.terminal).toBeNull();
    expect(readTerminalEvents(fresh, 'm1', 'task', 't1', 0, [])).toEqual([]);
    expect(ledger.getAttempt('a1')?.terminal?.strength).toBe('genuine');
});
it('actual remote terminal operation carries reducer evidence through member normalization with authority and receipt fences', async () => {
    const { db } = producer('mesh_queue', 'genuine');
    vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db } as any);
    // The member daemon is on the host's worker roster; a sender outside it is a follower and needs an ACL grant.
    const hostMesh = { id: 'm1', nodes: [{ id: 'n-member', daemonId: 'member-daemon' }] };
    setAssistantProjectPortsForTests(() => ({ listMeshes: () => [hostMesh], isHostedHere: () => true, selfDaemonId: () => 'host' }) as any);
    const handler = assistantRemoteHandlers.assistant_remote_project;
    const store = new TerminalWatchStore(db); const subscription: any = store.subscribe('member', 'task', 't1', 'assistant');
    const ports: any = { listMeshes: () => [{ id: 'member' }], isHostedHere: () => false, remoteHost: () => ({ reachable: true, hostMeshId: 'm1', hostDaemonId: 'host' }),
        callHost: async (_remote: any, op: string, args: any) => {
            const hostArgs = { meshId: 'm1', op, ...args }; markVerifiedMeshSender(hostArgs, 'member-daemon');
            return { ok: true, result: await handler({ components: () => ({}) } as any, hostArgs) };
        } };
    const events = await pendingTerminalEvents(store, ports, store.get(subscription.watchId)!);
    expect(events[0]).toMatchObject({ eventId: 'a1#committed', meshId: 'member', sourceMeshId: 'm1', strength: 'genuine', evidenceLevel: 'strong' });
    store.acknowledge(subscription.watchId, events[0]!.eventId);
    expect(await pendingTerminalEvents(store, ports, store.get(subscription.watchId)!)).toEqual([]);
});

it('real reducer terminals are stably bounded after receipt filtering; an ambiguous legacy receipt cannot hide genuine attempts', () => {
    const db = memDb(); dbs.push(db); const ledger = ledgerOn(db);
    for (let i = 19; i >= 0; i--) {
        const attemptId = `a${String(i).padStart(2, '0')}`;
        ledger.observe({ ...dispatch({ attemptId }), messageId: `msg-${i}`, attemptNo: i } as any);
        ledger.observe(evd('turn_started', { retro: false }, { attemptRef: { attemptId, generation: 0 } }));
        ledger.observe(evd('turn_end', { strength: 'genuine' }, { attemptRef: { attemptId, generation: 0 } }));
    }
    const records = new LocalRecordStore(db);
    records.insert({ eventId: 'legacy-ambiguous', meshId: 'm1', kind: 'task_completed', taskId: 't1', sessionId: 's1', nodeId: 'n1', atMs: T0, payload: {} });
    const first = readTerminalEvents(db, 'm1', 'task', 't1', 0, ['legacy-ambiguous']);
    expect(first).toHaveLength(16); expect(first.map(e => e.eventId)).toEqual(Array.from({ length: 16 }, (_, i) => `a${String(i).padStart(2, '0')}#committed`));
    const second = readTerminalEvents(db, 'm1', 'task', 't1', 0, ['legacy-ambiguous', ...first.map(e => e.eventId)]);
    expect(second.map(e => e.eventId)).toEqual(['a16#committed','a17#committed','a18#committed','a19#committed']);
});
it('actual watch command requires current recipient/project and exact current retry intent; pending never consumes', async () => {
    const { db } = producer('mesh_direct', 'genuine');
    const dir = mkdtempSync(join(tmpdir(), 'assistant-watch-command-'));
    try {
        const registry = new AssistantRegistry({ configDir: dir }); registry.bindSession({ sessionId: 'new-assistant', cliType: 'claude-cli', workspace: dir, at: 1 }); setAssistantRegistryForTests(registry);
        vi.spyOn(MeshRuntimeStore, 'getInstance').mockReturnValue({ db } as any);
        setAssistantProjectPortsForTests(() => ({ listMeshes: () => [{ id: 'm1' }], aliases: () => [], isHostedHere: () => true }) as any);
        const store = new TerminalWatchStore(db); const sub: any = store.subscribe('m1', 'task', 't1', 'assistant');
        const intent = store.beginDelivery(sub.watchId, 'a1#committed', 'old-assistant');
        const handler = assistantWatchSpecs.find(s => s.name === 'assistant_project_watch')!;
        const base = { project: 'm1', watchId: sub.watchId, eventId: 'a1#committed', assistantSessionId: 'new-assistant' };
        const ctx: any = { components: () => ({}) };
        const pending: any = await handler.run(ctx, { ...base, action: 'pending' });
        expect(pending).toMatchObject({ success: true, events: [{ originalRecipient: 'old-assistant', retryIdentity: terminalRetryIdentity(intent) }] });
        expect(store.receipts(sub.watchId)).toEqual([]);
        expect(await handler.run(ctx, { ...base, action: 'retry_delivery', retryIdentity: 'stale' })).toMatchObject({ success: false, code: 'terminal_delivery_intent_changed' });
        expect(await handler.run(ctx, { ...base, action: 'retry_delivery', assistantSessionId: 'old-assistant', retryIdentity: terminalRetryIdentity(intent) })).toMatchObject({ success: false, code: 'assistant_session_required' });
        expect(await handler.run(ctx, { ...base, action: 'retry_delivery', retryIdentity: terminalRetryIdentity(intent) })).toMatchObject({ success: true });
        const replacement = store.beginDelivery(sub.watchId, 'a1#committed', 'new-assistant');
        expect(await handler.run(ctx, { ...base, action: 'retry_delivery', retryIdentity: terminalRetryIdentity(intent) })).toMatchObject({ success: false, code: 'terminal_delivery_intent_changed' });
        expect(store.intent(sub.watchId, 'a1#committed')!.token).toBe(replacement.token);
    } finally { setAssistantRegistryForTests(null); rmSync(dir, { recursive: true, force: true }); }
});
