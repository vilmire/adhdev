import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The MAGI cross-verification engine was replaced by a coordinator prompt recipe.
// Its persisted state must leave an existing install cleanly: the mission provenance
// column, the dispatch/synthesis records, the machine-local kind-panel bindings and
// the session-cleanup policy key. Missions themselves are user data and stay.

const testTmpDir = join(tmpdir(), `adhdev-magi-retirement-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { tableColumns } from '../../src/mesh/mesh-runtime-store-schema.js';
import { upsertMeshMission, getMeshMissions } from '../../src/mesh/mesh-missions.js';
import { listMeshes } from '../../src/config/mesh-config.js';
import { normalizePolicyOverrides, resolveMeshPolicy } from '../../src/repo-mesh-types.js';

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('MAGI retirement — mesh-runtime.db migration', () => {
    it('drops mesh_missions.source and deletes MAGI records, keeping the missions and other records', () => {
        const meshId = `mesh-${randomUUID().slice(0, 8)}`;
        let store = MeshRuntimeStore.getInstance();
        // Recreate the pre-retirement shape on a fresh store: the provenance column
        // with a MAGI-stamped row, plus MAGI and non-MAGI local records.
        store.db.exec(`ALTER TABLE mesh_missions ADD COLUMN source TEXT`);
        const now = new Date().toISOString();
        store.db.prepare(
            `INSERT INTO mesh_missions (id, mesh_id, title, goal, status, source, created_at, updated_at)
             VALUES (?, ?, ?, '', 'completed', 'magi', ?, ?)`,
        ).run('m-magi', meshId, 'MAGI: why?', now, now);
        const insertRecord = store.db.prepare(
            `INSERT INTO mesh_local_records (event_id, mesh_id, kind, at_ms, payload_json) VALUES (?, ?, ?, ?, '{}')`,
        );
        insertRecord.run('r-dispatched', meshId, 'magi_dispatched', Date.now());
        insertRecord.run('r-synthesis', meshId, 'magi_synthesis', Date.now());
        insertRecord.run('r-keep', meshId, 'checkpoint_created', Date.now());
        expect(tableColumns(store, 'mesh_missions').has('source')).toBe(true);

        // Reopen: the boot-time migration runs.
        MeshRuntimeStore.resetForTests();
        store = MeshRuntimeStore.getInstance();

        expect(tableColumns(store, 'mesh_missions').has('source')).toBe(false);
        const kinds = (store.db.prepare(`SELECT kind FROM mesh_local_records WHERE mesh_id = ?`).all(meshId) as Array<{ kind: string }>)
            .map(r => r.kind);
        expect(kinds).toEqual(['checkpoint_created']);
        const missions = getMeshMissions(meshId);
        expect(missions.map(m => m.id)).toEqual(['m-magi']);
        expect(missions[0]).not.toHaveProperty('source');

        // Idempotent: a second boot is a no-op, and mission writes work on the new shape.
        MeshRuntimeStore.resetForTests();
        store = MeshRuntimeStore.getInstance();
        const created = upsertMeshMission(meshId, { title: 'after', status: 'active' });
        expect(getMeshMissions(meshId).map(m => m.id).sort()).toEqual(['m-magi', created.id].sort());
    });
});

describe('MAGI retirement — machine-local config', () => {
    it('strips magiKindPanels from the config root and every mesh entry on load, and persists it', () => {
        mkdirSync(testConfigDir, { recursive: true });
        const path = join(testConfigDir, 'meshes.json');
        writeFileSync(path, JSON.stringify({
            magiKindPanels: { rca: [{ provider: 'codex-cli' }] },
            meshes: [{
                id: 'mesh_a', name: 'm', repoIdentity: 'id_a', policy: {}, coordinator: {}, nodes: [],
                magiKindPanels: { design: [{ provider: 'claude-cli' }] },
            }],
        }, null, 2), 'utf-8');

        const meshes = listMeshes();
        expect(meshes).toHaveLength(1);
        expect(meshes[0]).not.toHaveProperty('magiKindPanels');
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        expect(raw).not.toHaveProperty('magiKindPanels');
        expect(raw.meshes[0]).not.toHaveProperty('magiKindPanels');
    });

    it('drops a stored magiSessionCleanup policy key during normalization', () => {
        const stored = normalizePolicyOverrides({ magiSessionCleanup: 'preserve' } as any);
        expect(stored).not.toHaveProperty('magiSessionCleanup');
        expect(resolveMeshPolicy({ magiSessionCleanup: 'preserve' } as any)).not.toHaveProperty('magiSessionCleanup');
    });
});
