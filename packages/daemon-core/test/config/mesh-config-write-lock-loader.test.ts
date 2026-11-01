import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loader = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock('../../src/system/load-better-sqlite3.js', async (orig) => {
    const real = await orig<typeof import('../../src/system/load-better-sqlite3.js')>();
    return {
        ...real,
        loadBetterSqlite3: (opts?: unknown) => {
            loader.calls.push(opts);
            if (loader.fail) throw new Error('Failed to load better-sqlite3: /opt/missing-addon/node_modules missing');
            return real.loadBetterSqlite3(opts as never);
        },
    };
});

import { acquireMeshConfigMutex, MeshConfigStrictLockError, __resetMeshConfigMutexIncarnationsForTests } from '../../src/config/mesh-config-write-lock.js';

describe('meshes.json write lock — native addon loading', () => {
    afterEach(() => { loader.calls.length = 0; loader.fail = false; __resetMeshConfigMutexIncarnationsForTests(); });

    it('loads better-sqlite3 without the cwd fallback', () => {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-wlock-'));
        const m = acquireMeshConfigMutex(join(dir, 'meshes.json'), 1000);
        m.release();
        expect(loader.calls).toEqual([{ allowCwdFallback: false }]);
    });

    it('a missing addon fails closed with a fixed reason and no raw error text', () => {
        loader.fail = true;
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-wlock-'));
        let err: unknown;
        try { acquireMeshConfigMutex(join(dir, 'meshes.json'), 1000); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(MeshConfigStrictLockError);
        expect((err as MeshConfigStrictLockError).reason).toBe('sqlite_module_unavailable');
        expect(String((err as Error).message)).not.toContain('/opt/missing-addon');
    });
});
