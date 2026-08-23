import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, utimesSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// P4b — meshes.json write serialization.
//
// Every mesh-config mutator is a read-modify-write over the WHOLE document and
// every save was a plain whole-file overwrite: two writers on one machine
// interleaving (clone_mesh_node's addNode vs apply_mesh_host_join, or the
// eager-migration persist in loadMeshConfig) silently dropped each other's
// entries. Live evidence 2026-08-22: meshes.json updatedAt 15:50:06.303Z OLDER
// than nodes stamped 15:50:13/15:50:31 — a stale copy was rewritten over them.
// The fix: a cross-process mkdir lock spanning load→mutate→save, plus an
// atomic tmp+rename save. These tests pin both, using only fixture dirs.

const testTmpDir = join(tmpdir(), `adhdev-mesh-config-lock-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' }),
}));

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
    return { id, name: id, repoIdentity: `identity/${id}`, policy: {}, coordinator: {}, nodes, createdAt: now, updatedAt: now };
}

/**
 * meshes.json round-trips unknown root fields verbatim, so a padding field
 * survives every load/save. A large file stretches each writer's
 * load→mutate→save span from sub-milliseconds to several milliseconds, which
 * makes the cross-process race deterministic: without the write lock the
 * four-writer test below loses updates on EVERY run, not just under load.
 */
const RACE_PADDING = 'x'.repeat(1024 * 1024);

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
                    ADHDEV_CONFIG_DIR: testConfigDir,
                    CHILD_MESH_ID: id,
                    CHILD_TAG: `w${idx}`,
                    CHILD_COUNT: '6',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
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
        // The lock itself is always released.
        expect(existsSync(lockPath())).toBe(false);
    }, 60_000);

    it('a stale lock abandoned by a crashed writer is broken, not wedged', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_stale')] });
        mkdirSync(lockPath());
        // 20s old — past the 15s stale threshold.
        const old = new Date(Date.now() - 20_000);
        utimesSync(lockPath(), old, old);

        const started = Date.now();
        const node = addNode('mesh_stale', { workspace: '/tmp/stale-lock-node' });
        expect(node).toBeDefined();
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(existsSync(lockPath())).toBe(false);
        expect(getMesh('mesh_stale')!.nodes.map(n => n.workspace)).toContain('/tmp/stale-lock-node');
    });

    it('a lock held by a live peer delays but never wedges the write (best-effort timeout)', () => {
        writeRawMeshConfig({ meshes: [baseMesh('mesh_held')] });
        mkdirSync(lockPath()); // fresh mtime — looks like a live peer mid-write

        const node = addNode('mesh_held', { workspace: '/tmp/held-lock-node' });
        expect(node).toBeDefined();
        expect(getMesh('mesh_held')!.nodes.map(n => n.workspace)).toContain('/tmp/held-lock-node');

        rmSync(lockPath(), { recursive: true, force: true });
    }, 15_000);

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
