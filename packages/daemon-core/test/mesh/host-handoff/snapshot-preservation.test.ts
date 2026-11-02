import { afterEach, describe, expect, it } from 'vitest';
import { DST, MESH, SRC, makeWorld, settle, type World } from './harness.js';
import { exportSnapshot, manifestDigest, sha256Hex, type ExportedSnapshot, type SnapshotPayload } from '../../../src/mesh/host-handoff/snapshot-export.js';
import { applySnapshotTables, localTableColumns, verifyStagedSnapshot } from '../../../src/mesh/host-handoff/snapshot-import.js';

let world: World;
afterEach(() => world?.cleanup());
function insert(table: string, values: Record<string, unknown>) {
    world.src.db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
}
function snapshot() {
    return exportSnapshot({ db: world.src.db as never, meshId: MESH, handoffId: 'snapshot', fromDaemonId: SRC,
        toDaemonId: DST, hostEpoch: 0, meshConfig: world.src.meshRecord });
}
function verify(s: ExportedSnapshot) { return verifyStagedSnapshot(s.manifest, s.chunks, localTableColumns(world.dst.db as never)); }
function repack(s: ExportedSnapshot, payload: SnapshotPayload): ExportedSnapshot {
    const data = JSON.stringify(payload), sha256 = sha256Hex(data);
    const header = { ...s.manifest, chunks: [{ seq: 0, sha256, bytes: Buffer.byteLength(data) }] };
    return { manifest: { ...header, digest: manifestDigest(header) }, chunks: [{ seq: 0, sha256, data }] };
}

describe('complete logical project snapshot preservation', () => {
    it('moves attempts, pending publication/delivery rows, holds, decisions, bodies and dependency payloads byte-for-byte', async () => {
        world = makeWorld({ sqliteJournal: true });
        insert('turn_attempts', { attempt_id: 'attempt', scope: 'mesh_queue', mesh_id: MESH, task_id: 'q1', session_id: 'worker',
            owner_daemon_id: SRC, state: 'terminal', terminal_outcome: 'completed', accepted_at: 1, created_at: 1, updated_at: 2 });
        insert('turn_events', { event_id: 'pending-notice', mesh_id: MESH, attempt_id: 'attempt', session_id: 'worker', kind: 'turn.notify',
            source: 'reducer', verdict: 'recorded', payload_json: '{"summary":"still undelivered"}', publish_state: 'pending', at_ms: 2, recorded_at: 2 });
        insert('turn_holds', { hold_id: 'hold', attempt_id: 'attempt', reason: 'owner approval', on_expire: 'hold', created_at: 1 });
        insert('mesh_topic_index', { writer: 'original-writer', seq: 7, mesh_id: MESH, event_id: 'pending-notice', kind: 'turn.notify', at_ms: 2, payload_json: '{"intendedFor":"old-coordinator"}' });
        insert('assistant_decision_answer_log', { mesh_id: MESH, item_id: 'i1', type_key: 'budget', choice_key: 'approved', choice_label: 'Approved', answered_at: 2, revision: 1 });
        insert('assistant_relays', { attempt_id: 'attempt', mesh_id: MESH, coordinator_session_id: 'old-coordinator', committed_at: 2, kind: 'turn', outcome: 'completed' });
        insert('assistant_relay_coverage', { attempt_id: 'attempt', coordinator_session_id: 'old-coordinator', rendered_at: 2, replies_json: '[]', reply_count: 0 });
        insert('assistant_attempt_bodies', { attempt_id: 'attempt', mesh_id: MESH, coordinator_session_id: 'old-coordinator', captured_at: 2, body: 'Original report body' });
        world.src.db.prepare('UPDATE mesh_queue SET payload=? WHERE id=?').run('{"dependsOn":["q0"],"message":"keep dependency"}', 'q1');
        const before = world.src.dump();
        await world.src.source.start({ meshId: MESH, targetDaemonId: DST }); await settle(world);
        expect(world.dst.mesh.read(MESH)?.role).toBe('host');
        expect(world.src.dump()).toEqual(before);
        expect(world.dst.dump()).toEqual(before);
    });

    it('preserves project memory stable IDs/text and its FTS index while global memory stays on its machine', () => {
        world = makeWorld();
        insert('assistant_memory_entry', { id: 'global-source', scope: 'global', project_ref: null, kind: 'rule', text: 'global source preference', origin: 'owner', created_at: 1, updated_at: 1 });
        insert('assistant_memory_entry', { id: 'project-memory', scope: 'project', project_ref: MESH, kind: 'lesson', text: 'preserved project lesson', origin: 'owner', created_at: 1, updated_at: 1 });
        world.dst.db.prepare("INSERT INTO assistant_memory_entry (id,scope,kind,text,origin,created_at,updated_at) VALUES ('global-target','global','rule','global target preference','owner',1,1)").run();
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(world.dst.db.prepare("SELECT id,text FROM assistant_memory_entry WHERE scope='project'").all()).toEqual([{ id: 'project-memory', text: 'preserved project lesson' }]);
        expect(world.dst.db.prepare("SELECT id FROM assistant_memory_entry WHERE scope='global'").all()).toEqual([{ id: 'global-target' }]);
        expect(world.dst.db.prepare("SELECT text FROM assistant_memory_fts WHERE assistant_memory_fts MATCH 'lesson'").all()).toEqual([{ text: 'preserved project lesson' }]);
        const globalInjection = structuredClone(result.payload);
        const memory = globalInjection.tables.assistant_memory_entry!;
        memory.rows[0]![memory.columns.indexOf('scope')] = 'global';
        expect(verify(repack(snapshot(), globalInjection))).toMatchObject({ ok: false, code: 'verify_failed', detail: 'global memory cannot travel with a project' });
    });

    it('rejects rehashed foreign rows and children outside the project snapshot', () => {
        world = makeWorld();
        const original = snapshot();
        const good = verify(original); expect(good.ok).toBe(true);
        if (!good.ok) throw new Error('fixture');
        const foreign = structuredClone(good.payload);
        foreign.tables.mesh_queue!.rows[0]![foreign.tables.mesh_queue!.columns.indexOf('mesh_id')] = 'unrelated';
        expect(verify(repack(original, foreign))).toMatchObject({ ok: false, code: 'verify_failed' });
        const child = structuredClone(good.payload);
        child.tables.turn_holds!.rows.push(child.tables.turn_holds!.columns.map(name => ({ hold_id: 'foreign-hold', attempt_id: 'foreign-attempt', reason: 'x', on_expire: 'hold', status: 'active', created_at: 1 } as Record<string, unknown>)[name] ?? null));
        const altered = repack(original, child);
        altered.manifest.tables.turn_holds!.rows = 1;
        altered.manifest.digest = manifestDigest(altered.manifest);
        expect(verify(altered)).toMatchObject({ ok: false, code: 'verify_failed' });
    });

    it('retains unrelated storage rows and explicitly maps colliding source sequence coordinates on retry', () => {
        world = makeWorld();
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (1,'foreign-mission','unrelated','created','owner','{}','now')").run();
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (100,'foreign-mission','unrelated','created','owner','{}','now')").run();
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload, undefined, 'origin-qualified-prototype');
        expect(() => applySnapshotTables(world.dst.db as never, MESH, result.payload)).toThrow('owner compatibility decision');
        const sourceTypes = world.src.db.prepare('SELECT type FROM mesh_mission_events WHERE mesh_id=? ORDER BY seq').all(MESH);
        expect(world.dst.db.prepare('SELECT type FROM mesh_mission_events WHERE mesh_id=? ORDER BY seq').all(MESH)).toEqual(sourceTypes);
        expect(world.dst.db.prepare('SELECT MIN(seq) AS n FROM mesh_mission_events WHERE mesh_id=?').get(MESH)).toEqual({ n: 101 });
        const first = world.dst.dump();
        applySnapshotTables(world.dst.db as never, MESH, result.payload, undefined, 'origin-qualified-prototype');
        expect(world.dst.dump()).toEqual(first);
        expect(world.dst.db.prepare("SELECT mesh_id FROM mesh_mission_events WHERE seq=1").get()).toEqual({ mesh_id: 'unrelated' });
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_handoff_row_map').get()).toEqual({ n: 2 });
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_handoff_archive').get()).toEqual({ n: 2 });
    });

    it('fails safely and retains every original byte on a history ID collision under the current production policy', () => {
        world = makeWorld();
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (1,'foreign-mission','unrelated','created','owner','{}','now')").run();
        const before = world.dst.dump();
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        expect(() => applySnapshotTables(world.dst.db as never, MESH, result.payload)).toThrow('owner compatibility decision');
        expect(world.dst.dump()).toEqual(before);
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_handoff_archive').get()).toEqual({ n: 0 });
    });

    it('keeps target-only local history and rolls back all effects on a conflicting local attempt', () => {
        world = makeWorld();
        world.dst.db.prepare("INSERT INTO mesh_local_records (event_id,mesh_id,kind,at_ms,node_id,payload_json) VALUES ('local-only',?,'local',1,'worker','{}')").run(MESH);
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(world.dst.db.prepare("SELECT event_id FROM mesh_local_records WHERE event_id='local-only'").get()).toEqual({ event_id: 'local-only' });
        insert('turn_attempts', { attempt_id: 'conflict', scope: 'mesh_queue', mesh_id: MESH, task_id: 'q1', session_id: 'source-worker',
            owner_daemon_id: SRC, state: 'terminal', terminal_outcome: 'completed', accepted_at: 1, created_at: 1, updated_at: 2 });
        world.dst.db.prepare("INSERT INTO turn_attempts (attempt_id,scope,mesh_id,session_id,owner_daemon_id,state,terminal_outcome,accepted_at,created_at,updated_at) VALUES ('conflict','mesh_queue',?,'target-worker','target','terminal','completed',1,1,2)").run(MESH);
        const conflict = verify(snapshot()); if (!conflict.ok) throw new Error(conflict.detail);
        const before = world.dst.dump();
        expect(() => applySnapshotTables(world.dst.db as never, MESH, conflict.payload)).toThrow('retained local state');
        expect(world.dst.dump()).toEqual(before);
    });
});
