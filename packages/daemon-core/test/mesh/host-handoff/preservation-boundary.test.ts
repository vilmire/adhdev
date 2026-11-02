import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js';
import { exportSnapshot } from '../../../src/mesh/host-handoff/snapshot-export.js';
import { applySnapshotTables, localTableColumns, verifyStagedSnapshot } from '../../../src/mesh/host-handoff/snapshot-import.js';
import { exportProjectApprovalFiles, importProjectApprovalFiles } from '../../../src/mesh/host-handoff/project-files.js';
import { adoptPendingNoticeReceipts, assessPreservationBoundary } from '../../../src/mesh/host-handoff/preservation-boundary.js';
import { acquireHandoffWriteFence } from '../../../src/mesh/host-handoff/write-fence.js';
import { DST, MESH, SRC, makeWorld, type World } from './harness.js';

let world: World;
afterEach(() => world?.cleanup());

const NOTICE = 'pending-notice';
const MEMORY = 'project-memory';
const APPROVAL = '{"id":"note1","kind":"note","meshId":"mesh-handoff-1","text":"original approval bytes"}';

function inventory(daemonDir: string, mesh: Record<string, unknown>) {
    writeFileSync(join(daemonDir, 'meshes.json'), JSON.stringify({ version: 1, meshes: [mesh] }));
}
function approval(dir: string, body = APPROVAL) {
    const staged = join(dir, 'assistant', 'staged');
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    writeFileSync(join(staged, 'note1.json'), body, { mode: 0o600 });
}
function populate(db: World['src']['db']) {
    db.prepare(`INSERT INTO turn_attempts (attempt_id, scope, mesh_id, task_id, session_id, owner_daemon_id, state, terminal_outcome, accepted_at, created_at, updated_at)
        VALUES ('attempt', 'mesh_queue', ?, 'q1', 'worker', ?, 'terminal', 'completed', 1, 1, 2)`).run(MESH, SRC);
    db.prepare(`INSERT INTO turn_events (event_id, mesh_id, attempt_id, session_id, kind, source, verdict, payload_json, publish_state, at_ms, recorded_at)
        VALUES (?, ?, 'attempt', 'worker', 'turn.notify', 'reducer', 'recorded', '{"summary":"still undelivered"}', 'pending', 2, 2)`).run(NOTICE, MESH);
    db.prepare(`INSERT INTO assistant_memory_entry (id, scope, project_ref, kind, text, origin, created_at, updated_at)
        VALUES (?, 'project', ?, 'lesson', 'preserved project lesson', 'owner', 1, 1)`).run(MEMORY, MESH);
}
function adopt(db: World['dst']['db'], payload: Parameters<typeof applySnapshotTables>[2], epoch = 1) {
    db.transaction(() => {
        applySnapshotTables(db as never, MESH, payload, { handoffId: 'h1', sourceDaemonId: SRC, snapshotDigest: 'digest', epoch });
        adoptPendingNoticeReceipts(db as never, MESH, payload, { handoffId: 'h1', epoch });
    })();
}

describe('production preservation boundary', () => {
    it('adopts one populated project and refuses a second notice delivery after restart', () => {
        world = makeWorld();
        inventory(world.src.dir, world.src.meshRecord);
        inventory(world.dst.dir, world.dst.meshRecord);
        approval(world.src.dir);
        populate(world.src.db);
        const ready = assessPreservationBoundary(world.src.db as never, world.src.dir, MESH);
        expect(ready).toMatchObject({ ok: true, id: 'state_preservation' });
        const files = exportProjectApprovalFiles(world.src.dir, MESH, ref => ref === MESH ? MESH : null);
        const exported = exportSnapshot({
            db: world.src.db as never, meshId: MESH, handoffId: 'h1', fromDaemonId: SRC, toDaemonId: DST, hostEpoch: 0,
            meshConfig: world.src.meshRecord, projectFiles: files,
        });
        const verified = verifyStagedSnapshot(exported.manifest, exported.chunks, localTableColumns(world.dst.db as never));
        expect(verified.ok).toBe(true);
        if (!verified.ok) throw new Error(verified.detail);
        adopt(world.dst.db, verified.payload);
        importProjectApprovalFiles(world.dst.dir, MESH, verified.payload.files, ref => ref === MESH ? MESH : null);
        expect(world.dst.db.prepare('SELECT id, text FROM assistant_memory_entry WHERE scope = ?').all('project')).toEqual([{ id: MEMORY, text: 'preserved project lesson' }]);
        expect(world.dst.db.prepare("SELECT text FROM assistant_memory_fts WHERE assistant_memory_fts MATCH 'lesson'").all()).toEqual([{ text: 'preserved project lesson' }]);
        expect(world.dst.db.prepare('SELECT event_id, publish_state FROM turn_events WHERE mesh_id = ?').all(MESH)).toEqual([{ event_id: NOTICE, publish_state: 'pending' }]);
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_notice_receipts').get()).toEqual({ n: 1 });
        expect(readFileSync(join(world.dst.dir, 'assistant', 'staged', 'note1.json'), 'utf8')).toBe(APPROVAL);
        expect(world.dst.db.prepare("SELECT id FROM mesh_queue WHERE id = 'other-q'").get()).toBeUndefined();
        expect(world.src.db.prepare("SELECT id FROM mesh_queue WHERE id = 'other-q'").get()).toEqual({ id: 'other-q' });
        adopt(world.dst.db, verified.payload);
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_host_notice_receipts').get()).toEqual({ n: 1 });
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM turn_events WHERE event_id = ?').get(NOTICE)).toEqual({ n: 1 });
        expect(() => adopt(world.dst.db, verified.payload, 2)).toThrow('stale epoch notice replay');
        acquireHandoffWriteFence(world.src.db as never, MESH, 'h1', 1);
        expect(() => world.src.db.prepare("UPDATE turn_events SET payload_json = '{}' WHERE event_id = ?").run(NOTICE)).toThrow(/mesh_host_handoff_fenced/);
        const sourcePath = join(world.src.dir, 'mesh-runtime.db');
        const targetPath = join(world.dst.dir, 'mesh-runtime.db');
        world.src.store.close();
        world.dst.store.close();
        const sourceAgain = new (MeshRuntimeStore as unknown as new (p: string) => MeshRuntimeStore)(sourcePath);
        const targetAgain = new (MeshRuntimeStore as unknown as new (p: string) => MeshRuntimeStore)(targetPath);
        try {
            expect(() => sourceAgain.db.prepare("UPDATE turn_events SET payload_json = '{}' WHERE event_id = ?").run(NOTICE)).toThrow(/mesh_host_handoff_fenced/);
            expect(targetAgain.db.prepare('SELECT event_id, payload_sha256 FROM mesh_host_notice_receipts').all()).toEqual([
                expect.objectContaining({ event_id: NOTICE }),
            ]);
            expect(targetAgain.db.prepare('SELECT id FROM assistant_memory_entry WHERE id = ?').get(MEMORY)).toEqual({ id: MEMORY });
        } finally {
            sourceAgain.close();
            targetAgain.close();
        }
    });

    it('rolls back a target history collision and keeps the source receipt unadopted', () => {
        world = makeWorld();
        inventory(world.src.dir, world.src.meshRecord);
        approval(world.src.dir);
        populate(world.src.db);
        world.dst.db.prepare("INSERT INTO mesh_mission_events (seq, mission_id, mesh_id, type, actor, payload_json, at) VALUES (1, 'foreign-mission', 'unrelated', 'created', 'owner', '{}', 'now')").run();
        const before = world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_mission_events').get();
        const exported = exportSnapshot({ db: world.src.db as never, meshId: MESH, handoffId: 'h1', fromDaemonId: SRC, toDaemonId: DST, hostEpoch: 0, meshConfig: world.src.meshRecord, projectFiles: [] });
        const verified = verifyStagedSnapshot(exported.manifest, exported.chunks, localTableColumns(world.dst.db as never));
        if (!verified.ok) throw new Error(verified.detail);
        expect(() => adopt(world.dst.db, verified.payload)).toThrow('owner compatibility decision');
        expect(world.dst.db.prepare('SELECT COUNT(*) AS n FROM mesh_mission_events').get()).toEqual(before);
        expect(world.dst.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mesh_host_notice_receipts'").get()).toBeUndefined();
    });

    it('stays fail-closed for an open turn, a consumed approval, and a missing project', () => {
        world = makeWorld();
        inventory(world.src.dir, world.src.meshRecord);
        approval(world.src.dir);
        populate(world.src.db);
        world.src.db.prepare(`INSERT INTO turn_attempts (attempt_id, scope, mesh_id, session_id, owner_daemon_id, state, accepted_at, created_at, updated_at)
            VALUES ('open', 'mesh_queue', ?, 'other-worker', ?, 'running', 1, 1, 1)`).run(MESH, SRC);
        expect(assessPreservationBoundary(world.src.db as never, world.src.dir, MESH)).toMatchObject({ ok: false, code: 'state_preservation_unverified', detail: 'a project turn is still open' });
        world.src.db.prepare("DELETE FROM turn_attempts WHERE attempt_id = 'open'").run();
        writeFileSync(join(world.src.dir, 'assistant', 'staged', 'note1.json.consumed'), APPROVAL);
        expect(assessPreservationBoundary(world.src.db as never, world.src.dir, MESH).detail).toBe('approval has both a live proposal and a consumed receipt');
        const original = readFileSync(join(world.src.dir, 'assistant', 'staged', 'note1.json'), 'utf8');
        const sha256 = createHash('sha256').update(APPROVAL).digest('hex');
        expect(() => importProjectApprovalFiles(world.src.dir, MESH, [{ area: 'staged', name: 'note1.json', meshId: MESH, sha256, data: APPROVAL }], ref => ref)).toThrow('approval consent receipt already retained');
        expect(readFileSync(join(world.src.dir, 'assistant', 'staged', 'note1.json'), 'utf8')).toBe(original);
        expect(readFileSync(join(world.src.dir, 'assistant', 'staged', 'note1.json.consumed'), 'utf8')).toBe(APPROVAL);
        expect(assessPreservationBoundary(world.src.db as never, world.src.dir, 'missing-project')).toMatchObject({ ok: false, code: 'state_preservation_unverified' });
    });
});
