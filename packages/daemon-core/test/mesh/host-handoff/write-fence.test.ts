import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireHandoffWriteFence, initializeHandoffWriteFences, registerHandoffImportFunction, releaseHandoffWriteFence, withHandoffImport } from '../../../src/mesh/host-handoff/write-fence.js';
import { MESH, makeWorld, type World } from './harness.js';
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';
import Database from 'better-sqlite3';
import { join } from 'node:path';

let world: World;
afterEach(() => world?.cleanup());

describe('durable per-project SQLite mutation cut', () => {
    it('blocks insert/update/delete for the selected project across connections while unrelated projects keep working', () => {
        world = makeWorld();
        const db = world.src.db;
        acquireHandoffWriteFence(db as never, MESH, 'handoff', 1);
        expect(() => db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('cancelled', MESH)).toThrow('mesh_host_handoff_fenced');
        expect(() => db.prepare('DELETE FROM mesh_missions WHERE mesh_id=?').run(MESH)).toThrow('mesh_host_handoff_fenced');
        const other = new Database(join(world.src.dir, 'mesh-runtime.db'));
        try {
            initializeHandoffWriteFences(other as never);
            expect(() => other.prepare("INSERT INTO mesh_scheduler_cursor (mesh_id,cursor) VALUES (?,1)").run(MESH)).toThrow('mesh_host_handoff_fenced');
            other.prepare("INSERT INTO mesh_scheduler_cursor (mesh_id,cursor) VALUES ('unrelated',7)").run();
            expect(other.prepare("SELECT cursor FROM mesh_scheduler_cursor WHERE mesh_id='unrelated'").get()).toEqual({ cursor: 7 });
        } finally { other.close(); }
        releaseHandoffWriteFence(db as never, MESH, 'handoff', false);
        db.prepare('UPDATE mesh_queue SET status=? WHERE id=?').run('pending', 'q1');
    });

    it('rolls back a failed trigger upgrade without an unfenced connection window', () => {
        world = makeWorld(); const db = world.src.db;
        acquireHandoffWriteFence(db as never, MESH, 'handoff', 1);
        const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'handoff_fence_%' ORDER BY name").all();
        const exec = db.exec.bind(db);
        const spy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
            if (sql.includes('DROP TRIGGER IF EXISTS handoff_fence_mesh_queue_update')) throw new Error('injected schema interruption');
            return exec(sql);
        });
        try { expect(() => initializeHandoffWriteFences(db as never)).toThrow('injected schema interruption'); }
        finally { spy.mockRestore(); }
        expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'handoff_fence_%' ORDER BY name").all()).toEqual(before);
        const other = new Database(join(world.src.dir, 'mesh-runtime.db'));
        try {
            registerHandoffImportFunction(other as never);
            expect(() => other.prepare("UPDATE mesh_queue SET status='pending' WHERE mesh_id=?").run(MESH)).toThrow('fenced');
        } finally { other.close(); }
    });

    it('registers the connection function before reopening migrations compile persisted triggers', () => {
        world = makeWorld();
        acquireHandoffWriteFence(world.src.db as never, MESH, 'handoff', 1);
        const reopened = new (MeshRuntimeStore as unknown as new (p: string) => MeshRuntimeStore)(join(world.src.dir, 'mesh-runtime.db'));
        try {
            expect(() => reopened.db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('pending', MESH)).toThrow('mesh_host_handoff_fenced');
            reopened.db.prepare("INSERT INTO mesh_scheduler_cursor (mesh_id,cursor) VALUES ('unrelated',9)").run();
        } finally { reopened.close(); }
    });

    it('does not freeze global memory carrying a legacy project_ref', () => {
        world = makeWorld(); const db = world.src.db;
        db.prepare("INSERT INTO assistant_memory_entry (id,scope,project_ref,kind,text,origin,created_at,updated_at) VALUES ('global','global',?,'rule','global preference','owner',1,1)").run(MESH);
        acquireHandoffWriteFence(db as never, MESH, 'handoff', 1);
        db.prepare("UPDATE assistant_memory_entry SET text='updated global preference' WHERE id='global'").run();
        expect(db.prepare("SELECT text FROM assistant_memory_entry WHERE id='global'").get()).toEqual({ text: 'updated global preference' });
    });

    it('keeps frozen history immutable while this member can create and update new worker-local records', () => {
        world = makeWorld(); const db = world.src.db;
        db.prepare("INSERT INTO turn_attempts (attempt_id,scope,mesh_id,session_id,owner_daemon_id,state,terminal_outcome,accepted_at,created_at,updated_at) VALUES ('old-attempt','mesh_queue',?,'old-worker','source','terminal','completed',1,1,2)").run(MESH);
        db.prepare("INSERT INTO turn_events (event_id,mesh_id,attempt_id,session_id,kind,source,verdict,at_ms,recorded_at) VALUES ('old-event',?,'old-attempt','old-worker','observed','native','recorded',1,1)").run(MESH);
        acquireHandoffWriteFence(db as never, MESH, 'handoff', 1);
        releaseHandoffWriteFence(db as never, MESH, 'handoff', true);
        expect(() => db.prepare("UPDATE turn_attempts SET state='active' WHERE attempt_id='old-attempt'").run()).toThrow('fenced');
        expect(() => db.prepare("UPDATE turn_events SET payload_json='{}' WHERE event_id='old-event'").run()).toThrow('fenced');
        expect(() => db.prepare("INSERT INTO turn_events (event_id,mesh_id,attempt_id,session_id,kind,source,verdict,at_ms,recorded_at) VALUES ('late-old-event',?,'old-attempt','old-worker','observed','native','recorded',3,3)").run(MESH)).toThrow('fenced');
        db.prepare("INSERT INTO turn_attempts (attempt_id,scope,mesh_id,session_id,owner_daemon_id,state,accepted_at,created_at,updated_at) VALUES ('new-worker-attempt','mesh_queue',?,'new-worker','source','accepted',3,3,3)").run(MESH);
        db.prepare("UPDATE turn_attempts SET state='active' WHERE attempt_id='new-worker-attempt'").run();
        db.prepare("INSERT INTO turn_events (event_id,mesh_id,attempt_id,session_id,kind,source,verdict,at_ms,recorded_at) VALUES ('new-event',?,'new-worker-attempt','new-worker','observed','native','recorded',3,3)").run(MESH);
        expect(db.prepare("SELECT state FROM turn_attempts WHERE attempt_id='new-worker-attempt'").get()).toEqual({ state: 'active' });
        expect(() => db.prepare("UPDATE mesh_queue SET status='pending' WHERE mesh_id=?").run(MESH)).toThrow('fenced');
    });

    it('scopes an import permit to one project, resets it on failure, and retains read-only source history after commit', () => {
        world = makeWorld(); const db = world.src.db;
        acquireHandoffWriteFence(db as never, MESH, 'handoff', 1);
        acquireHandoffWriteFence(db as never, 'other-mesh', 'other-handoff', 1);
        expect(() => withHandoffImport(db, MESH, () => {
            db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('pending', MESH);
            db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('pending', 'other-mesh');
        })).toThrow('mesh_host_handoff_fenced');
        expect(() => db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('pending', MESH)).toThrow('mesh_host_handoff_fenced');
        releaseHandoffWriteFence(db as never, MESH, 'handoff', true);
        expect(() => db.prepare('DELETE FROM mesh_queue WHERE mesh_id=?').run(MESH)).toThrow('mesh_host_handoff_fenced');
        expect(() => acquireHandoffWriteFence(db as never, MESH, 'stale', 1)).toThrow();
        acquireHandoffWriteFence(db as never, MESH, 'later-return', 2);
        releaseHandoffWriteFence(db as never, MESH, 'later-return', false);
        db.prepare('UPDATE mesh_queue SET status=? WHERE id=?').run('pending', 'q1');
    });
});
