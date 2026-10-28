import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, utimesSync, statSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// P4b — meshes.json write serialization.
//
// Every mesh-config mutator is a read-modify-write over the WHOLE document and
// every save was a plain whole-file overwrite: two writers on one machine
// interleaving (clone_mesh_node's addNode vs apply_mesh_host_join, or the
// eager-migration persist in loadMeshConfig) silently dropped each other's
// entries. Live evidence 2026-08-22: meshes.json updatedAt 15:50:06.303Z OLDER
// than nodes stamped 15:50:13/15:50:31 — a stale copy was rewritten over them.
// The fix: a persistent cross-process SQLite lock spanning load→mutate→save, plus an
// atomic tmp+rename save. These tests pin both, using only fixture dirs.

let testTmpDir = join(tmpdir(), `adhdev-mesh-config-lock-test-${randomUUID().slice(0, 8)}`);
let testConfigDir = join(testTmpDir, 'isolated-config');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
    getMachineId: () => (({ machineId: 'test-machine' }) as any).machineId,
    getMachineNickname: () => (({ machineId: 'test-machine' }) as any).machineNickname ?? null,
}));

import { withStrictMeshConfigWriteLock, MeshConfigStrictLockError } from '../../src/config/mesh-config-store.js';
import { reclaimStaleLegacyMeshConfigLock } from '../../src/config/mesh-config-legacy-lock.js';
import { addNode, listMeshes, getMesh } from '../../src/config/mesh-config.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const CHILD_SCRIPT = resolve(here, 'helpers', 'mesh-config-writer-child.ts');

function resolveTsxCli(): string {
    // daemon-core → packages → oss → worktree root; tsx lives in one of these
    // node_modules. Spawn it via process.execPath (it is a node CLI script).
    const candidates = [
        resolve(here, '../../../../node_modules/tsx/dist/cli.mjs'),
        resolve(here, '../../../../../node_modules/tsx/dist/cli.mjs'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error(`tsx CLI not found (looked: ${candidates.join(', ')})`);
}

function configPath(): string {
    return join(testConfigDir, 'meshes.json');
}

function lockPath(): string {
    return `${configPath()}.lock`;
}

function writeRawMeshConfig(config: unknown): void {
    if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function readRawMeshConfig(): any {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

function baseMesh(id: string, nodes: any[] = []): any {
    const now = new Date().toISOString();
    // policyStorage: 2 = a current-format file (no load-time migration to persist).
    return { id, name: id, repoIdentity: `identity/${id}`, policy: {}, policyStorage: 2, coordinator: {}, nodes, createdAt: now, updatedAt: now };
}

/**
 * meshes.json round-trips unknown root fields verbatim, so a padding field
 * survives every load/save. A large file stretches each writer's
 * load→mutate→save span from sub-milliseconds to several milliseconds, which
 * makes the cross-process race deterministic: without the write lock the
 * four-writer test below loses updates on EVERY run, not just under load.
 */
const RACE_PADDING = 'x'.repeat(1024 * 1024);

beforeEach(() => {
    testTmpDir = join(tmpdir(), `adhdev-mesh-config-lock-test-${randomUUID()}`);
    testConfigDir = join(testTmpDir, 'isolated-config');
});
afterEach(() => {
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('mesh-config — atomic save', () => {
    it('leaves no tmp siblings behind and produces valid 0o600 JSON', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_atomic')] });
        const node = addNode('mesh_atomic', { workspace: '/tmp/atomic-node' });
        expect(node).toBeDefined();

        const leftovers = readdirSync(testConfigDir).filter(f => f.startsWith('meshes.json.tmp'));
        expect(leftovers).toEqual([]);
        const parsed = readRawMeshConfig(); // throws if torn/invalid
        expect(parsed.meshes[0].nodes.map((n: any) => n.workspace)).toContain('/tmp/atomic-node');
        if (process.platform !== 'win32') {
            expect(statSync(configPath()).mode & 0o777).toBe(0o600);
        }
    });
});

describe('mesh-config — cross-process write lock', () => {
    it('four concurrent writers to the SAME file all survive (no last-writer-wins loss)', async () => {
        // Four meshes in ONE file, one child per mesh, 6 nodes each. The race is
        // file-level: any whole-file overwrite by a stale copy drops another
        // writer's nodes regardless of which mesh they targeted. Pre-lock this
        // loses updates on every run (the 1MB padding stretches each writer's
        // load→save span to milliseconds, so spans overlap constantly); with the
        // lock every load sees the previous writer's commit. 6 nodes/child keeps
        // each mesh under the 10-node cap.
        const meshIds = ['mesh_w0', 'mesh_w1', 'mesh_w2', 'mesh_w3'];
        writeRawMeshConfig({ padding: RACE_PADDING, meshes: meshIds.map(id => baseMesh(id)) });

        const tsx = resolveTsxCli();
        const children = meshIds.map((id, idx) => new Promise<{ code: number | null; output: string }>((res) => {
            const child = spawn(process.execPath, [tsx, CHILD_SCRIPT], {
                env: {
                    ...process.env,
                    HOME: testTmpDir,
                    ADHDEV_CONFIG_DIR: testConfigDir,
                    CHILD_MESH_ID: id,
                    CHILD_TAG: `w${idx}`,
                    CHILD_COUNT: '6',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let output = '';
            child.stdout.on('data', d => { output += d; });
            child.stderr.on('data', d => { output += d; });
            child.on('close', code => res({ code, output }));
        }));
        const results = await Promise.all(children);
        for (const r of results) {
            expect(r.code, r.output).toBe(0);
        }

        const parsed = readRawMeshConfig();
        const allNodeIds = parsed.meshes.flatMap((m: any) => m.nodes.map((n: any) => n.id));
        expect(allNodeIds).toHaveLength(24);
        for (let w = 0; w < 4; w++) {
            for (let i = 0; i < 6; i++) {
                expect(allNodeIds).toContain(`node_w${w}_${i}`);
            }
        }
        // Release preserves the mutex inode for every subsequent process.
        expect(existsSync(configPath()+'.write-lock.sqlite')).toBe(true);
        expect(existsSync(lockPath())).toBe(false);
    }, 60_000);

    it.each(['fresh','stale'])('refuses a %s legacy lock without deleting it or publishing', age => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_held')] });
        mkdirSync(lockPath());
        if (age === 'stale') utimesSync(lockPath(), new Date(0), new Date(0));
        expect(() => addNode('mesh_held', { workspace: '/tmp/held-lock-node' })).toThrow('write lock is held');
        expect(existsSync(lockPath())).toBe(true);
        expect(getMesh('mesh_held')!.nodes).toEqual([]);
    });

    it('reads stay correct while a peer holds the lock (listMeshes never blocks on it)', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_read', [{ id: 'node_r', workspace: '/tmp/r' }])] });
        mkdirSync(lockPath());
        const started = Date.now();
        const meshes = listMeshes();
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(meshes[0].nodes.map(n => n.id)).toEqual(['node_r']);
        rmSync(lockPath(), { recursive: true, force: true });
    });
});

describe('mesh-config — lock hardening', () => {
    const wl = () => `${configPath()}.write-lock.sqlite`;
    const legacyLock = (ageMs: number, marker = false) => {
        mkdirSync(lockPath(), { recursive: true });
        if (marker) writeFileSync(join(lockPath(), 'operator-recovery-owner'), 'x');
        const t = new Date(Date.now() - ageMs);
        utimesSync(lockPath(), t, t);
    };

    it('boot reclaim removes an old, empty legacy lock and writers then succeed', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_r')] });
        legacyLock(60 * 60_000);
        expect(reclaimStaleLegacyMeshConfigLock(configPath())).toMatchObject({ reclaimed: true });
        expect(existsSync(lockPath())).toBe(false);
        expect(addNode('mesh_r', { workspace: '/tmp/r1' })).toBeDefined();
    });

    it('boot reclaim keeps a fresh lock; writers still get store_busy with a legacy explanation', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_f')] });
        legacyLock(1000);
        expect(reclaimStaleLegacyMeshConfigLock(configPath())).toEqual({ reclaimed: false, reason: 'fresh' });
        expect(existsSync(lockPath())).toBe(true);
        let err: any;
        try { withStrictMeshConfigWriteLock(() => 1); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(MeshConfigStrictLockError);
        expect(err.code).toBe('store_busy');
        expect(err.reason).toBe('legacy_lock_present');
        expect(err.message).toContain('write lock is held');
        expect(err.message).toContain('older ADHDev version');
    });

    it('boot reclaim keeps an old lock that has the owner marker (or any contents) or is not a directory', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_m')] });
        legacyLock(60 * 60_000, true);
        expect(reclaimStaleLegacyMeshConfigLock(configPath())).toEqual({ reclaimed: false, reason: 'has_contents' });
        expect(existsSync(join(lockPath(), 'operator-recovery-owner'))).toBe(true);
        rmSync(lockPath(), { recursive: true });
        writeFileSync(lockPath(), 'file');
        expect(reclaimStaleLegacyMeshConfigLock(configPath())).toEqual({ reclaimed: false, reason: 'not_directory' });
        expect(reclaimStaleLegacyMeshConfigLock(join(testTmpDir, 'nowhere', 'meshes.json'))).toEqual({ reclaimed: false, reason: 'absent' });
    });

    it('chmod (ctime change) does not break a later acquire', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_c')] });
        expect(withStrictMeshConfigWriteLock(() => 1)).toBe(1);
        chmodSync(wl(), 0o644);
        chmodSync(wl(), 0o600);
        expect(withStrictMeshConfigWriteLock(() => 2)).toBe(2);
    });

    it('deleting and recreating the config dir between writes re-pins without a reset', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_d')] });
        expect(addNode('mesh_d', { workspace: '/tmp/d1' })).toBeDefined();
        rmSync(testConfigDir, { recursive: true, force: true });
        writeRawMeshConfig({ meshes: [baseMesh('mesh_d')] });
        expect(addNode('mesh_d', { workspace: '/tmp/d2' })).toBeDefined();
        rmSync(wl(), { force: true }); // lock file alone removed
        expect(addNode('mesh_d', { workspace: '/tmp/d3' })).toBeDefined();
    });

    it('mid-span replacement of the lock file is still refused and nothing is published', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_s')] });
        let err: any;
        try {
            withStrictMeshConfigWriteLock(() => {
                rmSync(wl());
                writeFileSync(wl(), '');
                addNode('mesh_s', { workspace: '/tmp/swapped' });
            });
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(MeshConfigStrictLockError);
        expect(err.code).toBe('project_storage_unavailable');
        expect(err.reason).toBe('path_changed');
        expect(err.message).toContain('restart the daemon');
        expect(getMesh('mesh_s')!.nodes).toEqual([]);
    });
});
