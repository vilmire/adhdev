import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TerminalWatchStore, readTerminalEvents, deliverTerminalEvents, TERMINAL_WATCH_TTL_MS } from '../../src/assistant/terminal-watch.js';
import { pendingTerminalEvents, TerminalWatchDelivery, confirmTerminalDelivery } from '../../src/assistant/terminal-watch-runtime.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
    const db = new Database(':memory:'); dbs.push(db);
    db.exec('CREATE TABLE mesh_local_records(event_id TEXT PRIMARY KEY,mesh_id TEXT,kind TEXT,task_id TEXT,session_id TEXT,node_id TEXT,at_ms INTEGER,payload_json TEXT)');
    const store = new TerminalWatchStore(db);
    const add = (id: string, mesh = 'mesh', at = 1, kind = 'task_completed', task = 'task', payload: any = {}) => db.prepare('INSERT INTO mesh_local_records VALUES (?,?,?,?,?,?,?,?)').run(id, mesh, kind, task, 'session', 'node', at, JSON.stringify({ secret: 'report body', ...payload }));
    return { store, add, db };
}
it('duplicate subscribe and terminal replay have stable identity; offline events remain pending until delivery is recorded', async () => {
    const { store, add } = fixture(); const sub: any = store.subscribe('mesh', 'task', 'task', 'assistant', 100);
    expect(store.subscribe('mesh', 'task', 'task', 'assistant', 101)).toMatchObject({ watchId: sub.watchId, duplicate: true });
    add('second', 'mesh', 2); add('first', 'mesh', 1); add('foreign', 'other');
    const watch = store.get(sub.watchId)!;
    let events = readTerminalEvents(store.db, 'mesh', 'task', 'task', 0, []);
    expect(events.map(e => e.eventId)).toEqual(['first', 'second']); expect(JSON.stringify(events)).not.toContain('report body');
    expect(events[0]).toMatchObject({ meshId: 'mesh', taskId: 'task', sessionId: 'session', nodeId: 'node' });
    await deliverTerminalEvents(events, watch, async () => false, store); expect(store.receipts(sub.watchId)).toEqual([]);
    expect(store.intent(sub.watchId, 'first')).toBeDefined();
    store.retryDelivery(sub.watchId, 'first'); // explicit retry when native delivery could not be proved
    const sent: string[] = []; await deliverTerminalEvents(events, watch, async id => { sent.push(id); return true; }, store);
    events = readTerminalEvents(store.db, 'mesh', 'task', 'task', 0, store.receipts(sub.watchId)); expect(events).toEqual([]);
    expect(sent[0]).toBe(`assistant-terminal:${sub.watchId}:first`);
    store.acknowledge(sub.watchId, 'first'); expect(store.receipts(sub.watchId)).toHaveLength(2);
    expect(store.list('assistant', 100 + TERMINAL_WATCH_TTL_MS)).toEqual([]);
});
it('busy/offline and a rebound assistant retain subscriptions and receipts across store recreation', async () => {
    const { store, add, db } = fixture(); store.subscribe('mesh', 'task', 'task', 'assistant'); add('event');
    let sid: string | null = null; let ready = false; const submit = vi.fn(async () => true);
    const ports: any = { listMeshes: () => [{ id: 'mesh' }], isHostedHere: () => true };
    const delivery = new TerminalWatchDelivery(new TerminalWatchStore(db), async () => ports, () => sid, () => ready, submit);
    await delivery.tick(); expect(submit).not.toHaveBeenCalled(); sid = 'new-assistant'; await delivery.tick(); expect(submit).not.toHaveBeenCalled();
    ready = true; await delivery.tick(); await delivery.tick(); expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0][0]).toBe('new-assistant');
});
it('remote terminal reads preserve origin identity, fence duplicate receipts, refuse cross-mesh events and remain pending on failure', async () => {
    const { store } = fixture(); const sub: any = store.subscribe('member', 'task', 'task', 'assistant'); const watch = store.get(sub.watchId)!;
    const event = { eventId: 'remote', meshId: 'host', taskId: 'task', missionId: null, sessionId: 'remote-session', nodeId: 'remote-node', kind: 'task_completed', at: 1, text: 'never leak' };
    const callHost = vi.fn(async () => ({ ok: true, result: { result: { events: [event, event] } } }));
    const ports: any = { listMeshes: () => [{ id: 'member' }], isHostedHere: () => false, remoteHost: () => ({ reachable: true, hostMeshId: 'host', hostDaemonId: 'remote-daemon' }), callHost };
    const pending = await pendingTerminalEvents(store, ports, watch); expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ meshId: 'member', sessionId: 'remote-session', nodeId: 'remote-node' }); expect(JSON.stringify(pending)).not.toContain('never leak');
    store.acknowledge(sub.watchId, 'remote'); await pendingTerminalEvents(store, ports, watch); expect(callHost.mock.calls[1][2].receipts).toEqual(['remote']);
    event.meshId = 'foreign'; await expect(pendingTerminalEvents(store, ports, watch)).rejects.toThrow('invalid_remote_identity');
    expect(store.receipts(sub.watchId)).toEqual(['remote']);
});
it('mission completion/abandonment filter and subscription cap are bounded', () => {
    const { store, add } = fixture(); add('active', 'mesh', 1, 'mission_status_changed', '', { missionId: 'm', toStatus: 'active' });
    add('done', 'mesh', 2, 'mission_status_changed', '', { missionId: 'm', toStatus: 'completed' });
    expect(readTerminalEvents(store.db, 'mesh', 'mission', 'm', 0, []).map(e => e.eventId)).toEqual(['done']);
    for (let i = 0; i < 32; i++) expect(store.subscribe('mesh', 'task', String(i), 'assistant').success).toBe(true);
    expect(store.subscribe('mesh', 'task', 'overflow', 'assistant')).toMatchObject({ success: false, code: 'terminal_watch_capacity' });
});

it('crash between submit and receipt cannot automatically duplicate or consume an event; exact native delivery confirms it', async () => {
    const { store, add, db } = fixture(); const sub: any = store.subscribe('mesh', 'task', 'task', 'assistant'); const watch = store.get(sub.watchId)!; add('crash-event');
    const events = readTerminalEvents(db, 'mesh', 'task', 'task', 0, []);
    const submit = vi.fn(async () => { throw Error('crashed before receipt'); });
    await expect(deliverTerminalEvents(events, watch, submit, store, { recipient: 'original-assistant' })).rejects.toThrow('crashed');
    const intent = store.intent(sub.watchId, 'crash-event')!; expect(store.receipts(sub.watchId)).toEqual([]);
    const replacementStore = new TerminalWatchStore(db); const noSend = vi.fn(async () => true);
    await deliverTerminalEvents(events, watch, noSend, replacementStore, { confirm: async () => false });
    expect(noSend).not.toHaveBeenCalled(); expect(store.receipts(sub.watchId)).toEqual([]);
    const text = `[ADHDev task/mission terminal] {"deliveryToken":"${intent.token}"}`;
    const execute = vi.fn(async () => ({ success: true, messages: [{ role: 'assistant', content: text }], hasMore: false }));
    const ports: any = { execute };
    expect(await confirmTerminalDelivery(ports, intent)).toBe(false); // provider text is not proof of daemon delivery
    execute.mockImplementation(async () => ({ success: true, messages: [{ role: 'user', content: text }], hasMore: false }));
    await deliverTerminalEvents(events, watch, noSend, replacementStore, { confirm: i => confirmTerminalDelivery(ports, i) });
    expect(noSend).not.toHaveBeenCalled(); expect(store.receipts(sub.watchId)).toEqual(['crash-event']);
    expect(execute.mock.calls.every(c => c[1].targetSessionId === 'original-assistant')).toBe(true);
});

it('native relay submission records terminal receipt and relay attribution; an MCP pull alone records no receipt', async () => {
    const { AssistantRelay } = await import('../../src/assistant/assistant-relay.js');
    const { InMemoryAssistantRelayStore } = await import('../../src/assistant/assistant-relay-store.js');
    const { AssistantInputLog } = await import('../../src/assistant/assistant-input-log.js');
    for (const native of [false, true]) {
        const { store } = fixture(); const sub: any = store.subscribe('mesh', 'task', 'task', 'assistant');
        const intent = store.beginDelivery(sub.watchId, 'event', 'bound');
        const id = `assistant-terminal:${sub.watchId}:event`; const log = new AssistantInputLog(); log.begin('bound'); log.append('bound', 'human');
        const relay = new AssistantRelay({ subscribe: () => () => {}, coordinatorMeshOf: () => null, projectSlug: () => 'p',
            readCoordinatorTail: async () => null, meshWork: () => null, hasAssistant: () => true, assistantSessionId: () => native ? 'bound' : null,
            isAssistantReady: () => native, submit: async () => ({ kind: 'delivered' }), inputLog: log, store: new InMemoryAssistantRelayStore(),
            onInputsSubmitted: (sid, ids) => { if (sid === intent.recipient_session_id && ids.includes(id)) store.acknowledge(sub.watchId, 'event'); } });
        relay.start(); relay.enqueueInput({ source: 'relay', text: `[ADHDev task/mission terminal] {"deliveryToken":"${intent.token}"}`, messageId: id, forSessionId: 'bound' });
        if (native) { await relay.idle(); expect(store.receipts(sub.watchId)).toEqual(['event']); }
        else { const events = await relay.pullPending('bound'); expect(events).toHaveLength(1); expect(store.receipts(sub.watchId)).toEqual([]); }
        expect(log.sources('bound').at(-1)).toBe('relay'); relay.stop();
    }
});
it('recreated recipient gets bounded uncertainty once, can explicitly resume, and original native evidence settles without duplication', async () => {
    for (const confirmed of [false, true]) {
        const { store, add } = fixture(); const sub: any = store.subscribe('mesh', 'task', 'task', 'assistant');
        add('first', 'mesh', 1); add('second', 'mesh', 2);
        const intent = store.beginDelivery(sub.watchId, 'first', 'old-assistant');
        const text = `[ADHDev task/mission terminal] {"deliveryToken":"${intent.token}"}`;
        const execute = vi.fn(async () => ({ success: true, messages: confirmed ? [{ role: 'user', content: text }] : [], hasMore: false }));
        const ports: any = { listMeshes: () => [{ id: 'mesh' }], isHostedHere: () => true, execute };
        const submit = vi.fn(async () => true);
        const delivery = new TerminalWatchDelivery(store, async () => ports, () => 'new-assistant', () => true, submit);
        await delivery.tick(); await delivery.tick();
        expect(execute.mock.calls.every((c: any) => c[1].targetSessionId === 'old-assistant')).toBe(true);
        if (confirmed) {
            expect(store.receipts(sub.watchId)).toEqual(['first','second']); expect(submit).toHaveBeenCalledTimes(1);
            expect(submit.mock.calls[0][2]).toContain('"eventId":"second"');
        } else {
            expect(store.receipts(sub.watchId)).toEqual([]); expect(submit).toHaveBeenCalledTimes(1);
            expect(submit.mock.calls[0][0]).toBe('new-assistant'); expect(submit.mock.calls[0][2]).toContain('unconfirmed_original_recipient');
            expect(submit.mock.calls[0][2]).not.toContain(intent.token);
            store.retryDelivery(sub.watchId, 'first'); await delivery.tick();
            expect(store.receipts(sub.watchId)).toEqual(['first','second']); expect(submit).toHaveBeenCalledTimes(3);
        }
    }
});
