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

    it('refuses an exact (project, seq) collision and retains every original byte', () => {
        world = makeWorld();
        world.dst.db.prepare("INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at) VALUES ('m1', ?, 't', 'g', 'active', 'now', 'now')").run(MESH);
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (1,'m1',?,'different','owner','{}','now')").run(MESH);
        const before = world.dst.dump();
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        expect(() => applySnapshotTables(world.dst.db as never, MESH, result.payload)).toThrow('history identity collision');
        expect(world.dst.dump()).toEqual(before);
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_handoff_archive').get()).toEqual({ n: 0 });
    });

    it('another project with the same seq is not a collision: both keep their exact ids and new events still number', () => {
        world = makeWorld();
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (1,'foreign-mission','unrelated','created','owner','{}','now')").run();
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq,mission_id,mesh_id,type,actor,payload_json,at) VALUES (100,'foreign-mission','unrelated','created','owner','{}','now')").run();
        const sourceRows = world.src.db.prepare('SELECT seq, mission_id, type FROM mesh_mission_events WHERE mesh_id=? ORDER BY seq').all(MESH);
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(world.dst.db.prepare('SELECT seq, mission_id, type FROM mesh_mission_events WHERE mesh_id=? ORDER BY seq').all(MESH)).toEqual(sourceRows);
        expect(world.dst.db.prepare("SELECT seq, mission_id, type FROM mesh_mission_events WHERE mesh_id='unrelated' ORDER BY seq").all()).toEqual([
            { seq: 1, mission_id: 'foreign-mission', type: 'created' }, { seq: 100, mission_id: 'foreign-mission', type: 'created' }]);
        // Idempotent replay, and the row_id never travels back out.
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(Object.keys(world.dst.db.prepare('SELECT * FROM mesh_mission_events LIMIT 1').get() as object)).toContain('row_id');
        expect(world.dst.dump().mesh_mission_events![0]).toHaveLength((sourceRows.length && Object.keys(world.src.db.prepare('SELECT * FROM mesh_mission_events LIMIT 1').get() as object).length) as number);
        // A statement that names no seq, as every insert site does, gets the next one.
        const info = world.dst.db.prepare("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('m1', ?, 'after', 'owner', '{}', 'now')").run(MESH);
        expect((world.dst.db.prepare('SELECT seq FROM mesh_mission_events WHERE rowid = ?').get(info.lastInsertRowid) as { seq: number }).seq).toBeGreaterThan(100);
    });

    it('a per-daemon log with colliding private ids appends instead of refusing, once', () => {
        world = makeWorld();
        const log = "INSERT INTO mesh_tool_call_log (id, mesh_id, tool, session_id, caller_role, called_at) VALUES (?,?,?,?,?,?)";
        world.src.db.prepare(log).run(7, MESH, 'mesh_status', 's', 'coordinator', 5);
        world.dst.db.prepare(log).run(7, 'unrelated', 'mesh_status', 's', 'coordinator', 6);
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(world.dst.db.prepare('SELECT mesh_id, called_at FROM mesh_tool_call_log ORDER BY called_at').all()).toEqual([{ mesh_id: MESH, called_at: 5 }, { mesh_id: 'unrelated', called_at: 6 }]);
    });

    it('a worker\'s own observation of an event keeps its local row unless the source still owes the notice', () => {
        world = makeWorld();
        const event = (over: Record<string, unknown>) => ({ event_id: 'e1', mesh_id: MESH, attempt_id: null, generation: 0, session_id: 's', kind: 'k', source: 'x', verdict: 'recorded', dedupe_key: 'd', payload_json: '{}', publish_state: 'none', at_ms: 1, recorded_at: 1, ...over });
        const put = (db: typeof world.src.db, row: Record<string, unknown>) => db.prepare(`INSERT INTO turn_events (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
        put(world.src.db, event({ publish_state: 'published', published_seq: 4 }));
        put(world.dst.db, event({}));
        put(world.src.db, event({ event_id: 'e2', dedupe_key: 'p', publish_state: 'pending' }));
        put(world.dst.db, event({ event_id: 'e2', dedupe_key: 'p' }));
        const result = verify(snapshot()); if (!result.ok) throw new Error(result.detail);
        applySnapshotTables(world.dst.db as never, MESH, result.payload);
        expect(world.dst.db.prepare("SELECT event_id, publish_state FROM turn_events WHERE event_id IN ('e1','e2') ORDER BY event_id").all()).toEqual([
            { event_id: 'e1', publish_state: 'none' }, { event_id: 'e2', publish_state: 'pending' }]);
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

    it('a source-origin artifact row replaces the local copy when the origin id is stored in another daemon-id form', () => {
        world = makeWorld({ sqliteJournal: true });
        const art = (origin: string, title: string) => ({ artifact_id: 'art-1', session_id: 'worker', mesh_id: MESH, origin_daemon_id: origin, workspace_root: '/ws',
            rel_path: 'out.md', kind: 'file', mime: 'text/markdown', title, size_bytes: 1, sha256: 'aa', created_at: 1, updated_at: 2 });
        insert('session_artifacts', art(SRC, 'from source'));
        const snap = snapshot();
        const payload = JSON.parse(snap.chunks[0]!.data) as SnapshotPayload;
        // The target already holds the same artifact, its origin recorded in the bare machine form of the SAME source daemon.
        world.dst.db.prepare(`INSERT INTO session_artifacts (${Object.keys(art('x', 't')).join(',')}) VALUES (${Object.keys(art('x', 't')).map(() => '?').join(',')})`)
            .run(...Object.values(art(SRC.replace(/^daemon_/, ''), 'stale local copy')));
        applySnapshotTables(world.dst.db as never, MESH, payload, { handoffId: 'h-alias', sourceDaemonId: SRC, snapshotDigest: snap.manifest.digest });
        const row = world.dst.db.prepare('SELECT title FROM session_artifacts WHERE artifact_id=?').get('art-1') as { title: string };
        expect(row.title).toBe('from source');
    });
});
