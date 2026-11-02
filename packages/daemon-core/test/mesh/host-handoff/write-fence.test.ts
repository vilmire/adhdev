import { afterEach, describe, expect, it } from 'vitest';
import { acquireHandoffWriteFence, initializeHandoffWriteFences, releaseHandoffWriteFence, withHandoffImport } from '../../../src/mesh/host-handoff/write-fence.js';
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

    it('registers the connection function before reopening migrations compile persisted triggers', () => {
        world = makeWorld();
        acquireHandoffWriteFence(world.src.db as never, MESH, 'handoff', 1);
        const reopened = new (MeshRuntimeStore as unknown as new (p: string) => MeshRuntimeStore)(join(world.src.dir, 'mesh-runtime.db'));
        try {
            expect(() => reopened.db.prepare('UPDATE mesh_queue SET status=? WHERE mesh_id=?').run('pending', MESH)).toThrow('mesh_host_handoff_fenced');
            reopened.db.prepare("INSERT INTO mesh_scheduler_cursor (mesh_id,cursor) VALUES ('unrelated',9)").run();
        } finally { reopened.close(); }
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
