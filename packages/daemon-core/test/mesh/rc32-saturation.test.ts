import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../../src/config/config.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { recordTaskAutoLaunch } from '../../src/mesh/mesh-autolaunch-spawn-budget.js';
import { recordQueueTaskHold } from '../../src/mesh/mesh-queue-hold-store.js';
import { syncInlineMeshPoliciesFromDisk } from '../../src/commands/router-inline-mesh-roster.js';
import { listMatchingFiles } from '../../src/providers/spec/native-history-paths.js';
vi.mock('node:fs', async importOriginal => { const fs = await importOriginal<typeof import('node:fs')>(); return { ...fs, readdirSync: vi.fn(fs.readdirSync) }; });
const task = (id: string) => ({ id, meshId: 'saturation', status: 'pending', message: id, createdAt: '2026-01-01', updatedAt: '2026-01-01', revision: 1 } as any);
afterEach(() => { vi.restoreAllMocks(); MeshRuntimeStore.resetForTests(); });
describe('rc32 saturation regressions', () => {
    it('parses config once and observes writes and same-size same-mtime replacement', () => {
        saveMeshConfig({ meshes: [] });
        const parse = vi.spyOn(JSON, 'parse');
        loadMeshConfig(); loadMeshConfig();
        expect(parse).toHaveBeenCalledTimes(1);
        parse.mockRestore();
        const config = loadMeshConfig(); config.meshes.push({ id: 'unsaved' } as any);
        expect(loadMeshConfig().meshes).toEqual([]);
        saveMeshConfig({ meshes: [{ id: 'one', policyStorage: 2, nodes: [] }] } as any);
        expect(loadMeshConfig().meshes[0].id).toBe('one');
        const path = join(getConfigDir(), 'meshes.json'); const stat = fs.statSync(path);
        fs.writeFileSync(path + '.replacement', fs.readFileSync(path, 'utf8').replace('one', 'two'));
        fs.utimesSync(path + '.replacement', stat.atime, stat.mtime);
        fs.renameSync(path + '.replacement', path);
        expect(loadMeshConfig().meshes[0].id).toBe('two');
    });
    it('inline policy snapshots also observe same-size same-mtime inode replacement', () => {
        const path = join(getConfigDir(), 'meshes.json');
        const document = { meshes: [{ id: 'inline', policy: { maxTaskRetries: 1 } }] };
        fs.writeFileSync(path, JSON.stringify(document));
        fs.utimesSync(path, new Date(1_000_000), new Date(1_000_000));
        const host: any = { inlineMeshCache: new Map([['inline', { id: 'inline', policy: { maxTaskRetries: 1 }, nodes: [] }]]),
            meshPolicyDiskSync: { checkedAtMs: 0, mtimeMs: -1, size: -1, ino: -1 }, invalidateAggregateMeshStatus: vi.fn() };
        syncInlineMeshPoliciesFromDisk(host);
        document.meshes[0].policy.maxTaskRetries = 2;
        fs.writeFileSync(path + '.next', JSON.stringify(document));
        fs.utimesSync(path + '.next', new Date(1_000_000), new Date(1_000_000));
        fs.renameSync(path + '.next', path);
        host.meshPolicyDiskSync.checkedAtMs = 0;
        syncInlineMeshPoliciesFromDisk(host);
        expect(host.inlineMeshCache.get('inline').policy.maxTaskRetries).toBe(2);
    });
    it('replacement only mutates changed rows and deletes removed rows', () => {
        const store = MeshRuntimeStore.getInstance();
        store.replaceQueue('saturation', [task('a'), task('b'), task('c')]);
        store.db.exec(`CREATE TABLE mutations (op TEXT, id TEXT);
            CREATE TRIGGER q_update AFTER UPDATE ON mesh_queue BEGIN INSERT INTO mutations VALUES ('update', new.id); END;
            CREATE TRIGGER q_insert AFTER INSERT ON mesh_queue BEGIN INSERT INTO mutations VALUES ('insert', new.id); END;
            CREATE TRIGGER q_delete AFTER DELETE ON mesh_queue BEGIN INSERT INTO mutations VALUES ('delete', old.id); END;`);
        store.replaceQueue('saturation', [task('a'), { ...task('b'), message: 'changed' }, task('d')]);
        expect(store.db.prepare('SELECT * FROM mutations ORDER BY id').all()).toEqual([
            { op: 'update', id: 'b' }, { op: 'delete', id: 'c' }, { op: 'insert', id: 'd' },
        ]);
    });
    it('scheduling reads only active tasks and their reachable historical prerequisites', () => {
        const store = MeshRuntimeStore.getInstance();
        store.replaceQueue('saturation', [
            { ...task('root'), phase: 'integration', dependsOn: ['source'] },
            { ...task('source'), phase: 'source', status: 'completed' },
            { ...task('unrelated-history'), status: 'completed', message: 'large history'.repeat(1000) },
        ]);
        expect(store.getQueueSchedulingGraph('saturation').map(t => t.id).sort()).toEqual(['root', 'source']);
    });
    it('claim ticks never read unfiltered history or rewrite an unchanged hold', () => {
        const store = MeshRuntimeStore.getInstance();
        store.replaceQueue('saturation', [
            { ...task('waiting'), dependsOn: ['missing'] },
            { ...task('history'), status: 'completed' },
        ]);
        const reads = vi.spyOn(store, 'getQueueEntries');
        expect(store.claimNextQueueTask('saturation', 'node', 'session')).toBeNull();
        const changes = () => (store.db.prepare('SELECT total_changes() AS n').get() as any).n;
        const n = changes();
        expect(store.claimNextQueueTask('saturation', 'node', 'session')).toBeNull();
        expect(reads.mock.calls.every(([, statuses]) => statuses?.length)).toBe(true);
        expect(changes()).toBe(n);
    });
    it('unchanged hold and skipped auto-launch do not write or bump revision', () => {
        const store = MeshRuntimeStore.getInstance(); store.replaceQueue('saturation', [task('a')]);
        const skipped = { status: 'skipped', reason: 'node_has_active_assignment' } as any;
        recordTaskAutoLaunch('saturation', 'a', skipped); recordQueueTaskHold('saturation', 'a', skipped.reason);
        const before = store.findQueueEntryById('saturation', 'a');
        const changes = () => (store.db.prepare('SELECT total_changes() AS n').get() as any).n; const n = changes();
        recordTaskAutoLaunch('saturation', 'a', skipped); recordQueueTaskHold('saturation', 'a', skipped.reason);
        expect(store.findQueueEntryById('saturation', 'a')).toEqual(before); expect(changes()).toBe(n);
    });
    it('caches directory listings and observes newly created files', () => {
        const dir = join(getConfigDir(), 'transcript-list'); fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'a.jsonl'), '');
        const read = vi.spyOn(fs, 'readdirSync');
        expect(listMatchingFiles(dir, /jsonl$/)).toHaveLength(1); expect(listMatchingFiles(dir, /jsonl$/)).toHaveLength(1);
        expect(read).toHaveBeenCalledTimes(1);
        fs.writeFileSync(join(dir, 'b.jsonl'), ''); fs.utimesSync(dir, new Date(), new Date(Date.now() + 1000));
        expect(listMatchingFiles(dir, /jsonl$/)).toHaveLength(2);
    });
});
