// ---------------------------------------------------------------------------
// lifecycle retention Slice 1 — mesh_session_delivery age pruning + per-mesh
// ledger rotation byte/count caps + retention config resolvers.
//
// ISOLATION: every fixture write goes under a per-run TEMP config root
// (vi.mock of config.js getConfigDir) — nothing ever touches the real
// ~/.adhdev/mesh-ledger.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-lifecycle-retention-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-host-machine' }),
}));

import {
    MeshRuntimeStore,
    pruneMeshRuntimeRetention,
} from '../../src/mesh/mesh-runtime-store.js';
import {
    getLedgerDir,
    planLedgerRotationEvictions,
    enforceLedgerRotationCap,
    enforceAllLedgerRotationCaps,
} from '../../src/mesh/mesh-ledger.js';
import {
    DEFAULT_SESSION_DELIVERY_RETENTION_MS,
    DEFAULT_LEDGER_ROTATION_MAX_BYTES,
    DEFAULT_LEDGER_ROTATION_MAX_FILES,
    resolveSessionDeliveryRetentionMs,
    resolveLedgerRotationMaxBytes,
    resolveLedgerRotationMaxFiles,
} from '../../src/mesh/mesh-retention-config.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const MESH = 'mesh_lifecycle_test';
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const RETENTION_ENV_VARS = [
    'MESH_SESSION_DELIVERY_RETENTION_MS',
    'MESH_LEDGER_ROTATION_MAX_BYTES',
    'MESH_LEDGER_ROTATION_MAX_FILES',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
}

function insertDelivery(id: string, status: string, updatedAt: string, taskId?: string): void {
    MeshRuntimeStore.getInstance().insertSessionDelivery({
        id,
        meshId: MESH,
        kind: 'task_message',
        message: `msg ${id}`,
        status,
        taskId,
        createdAt: updatedAt,
        updatedAt,
    });
}

function writeLedgerFile(name: string, lines: Array<Record<string, unknown> | string>, mtimeMs?: number): string {
    const p = join(getLedgerDir(), name);
    fs.writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : ''), 'utf-8');
    if (mtimeMs !== undefined) {
        const d = new Date(mtimeMs);
        fs.utimesSync(p, d, d);
    }
    return p;
}

function ledgerEntry(kind: string): Record<string, unknown> {
    return { id: randomUUID(), meshId: MESH, timestamp: new Date().toISOString(), kind, payload: {} };
}

function readArchivedCounts(): any {
    const p = join(getLedgerDir(), `${MESH}.archived-counts.json`);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

beforeEach(() => {
    for (const v of RETENTION_ENV_VARS) {
        savedEnv[v] = process.env[v];
        delete process.env[v];
    }
    __resetMeshRuntimeStoreForTests();
    fs.rmSync(join(testConfigDir, 'mesh-ledger'), { recursive: true, force: true });
    fs.mkdirSync(join(testConfigDir, 'mesh-ledger'), { recursive: true });
});

afterEach(() => {
    for (const v of RETENTION_ENV_VARS) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
    }
    vi.useRealTimers();
});

describe('test isolation', () => {
    it('resolves the ledger dir under the temp config root, never the real ~/.adhdev', () => {
        expect(getLedgerDir().startsWith(testConfigDir)).toBe(true);
        expect(getLedgerDir()).not.toContain(join(homedir(), '.adhdev'));
    });
});

// ─── (1) mesh_session_delivery retention ─────────────────────────────────────

describe('pruneTerminalSessionDeliveries', () => {
    it('deletes aged terminal-outcome rows but preserves aged live/nonterminal rows', () => {
        const store = MeshRuntimeStore.getInstance();
        const aged = isoAgo(20 * DAY_MS);
        // Terminal outcomes → prunable.
        insertDelivery('d-completed', 'completed', aged, 't-completed');
        insertDelivery('d-failed', 'failed', aged);
        insertDelivery('d-expired', 'expired', aged);
        insertDelivery('d-cancelled', 'cancelled', aged);
        // Live/nonterminal (progress ranks) → preserved for retry/recovery semantics.
        insertDelivery('d-queued', 'queued', aged);
        insertDelivery('d-delivering', 'delivering', aged);
        insertDelivery('d-delivered', 'delivered', aged, 't-delivered');
        insertDelivery('d-acked', 'acked', aged, 't-acked');

        const removed = store.pruneTerminalSessionDeliveries(DEFAULT_SESSION_DELIVERY_RETENTION_MS);
        expect(removed).toBe(4);

        // Live rows survive: queued/delivering are active...
        const activeIds = store.getActiveSessionDeliveries(MESH).map(r => r.id);
        expect(activeIds).toContain('d-queued');
        expect(activeIds).toContain('d-delivering');
        // ...and delivered/acked still back the confirmed-delivery recovery reads.
        expect(store.taskHasConfirmedDelivery(MESH, 't-delivered')).toBe(true);
        expect(store.taskHasConfirmedDelivery(MESH, 't-acked')).toBe(true);
        expect(store.taskDeliveryConsumed(MESH, 't-acked')).toBe(true);
        // The aged terminal row is gone from the recovery surface too.
        expect(store.taskHasConfirmedDelivery(MESH, 't-completed')).toBe(false);
    });

    it('keeps terminal rows still inside the retention window', () => {
        const store = MeshRuntimeStore.getInstance();
        insertDelivery('d-recent-done', 'completed', isoAgo(2 * DAY_MS));
        insertDelivery('d-recent-failed', 'failed', isoAgo(1 * DAY_MS));
        const removed = store.pruneTerminalSessionDeliveries(DEFAULT_SESSION_DELIVERY_RETENTION_MS);
        expect(removed).toBe(0);
    });

    it('keeps a row exactly AT the cutoff (strict <) and prunes one 1ms past it', () => {
        const fixedNow = 1_760_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);
        const store = MeshRuntimeStore.getInstance();
        const window = DEFAULT_SESSION_DELIVERY_RETENTION_MS;
        insertDelivery('d-edge', 'completed', new Date(fixedNow - window).toISOString());
        insertDelivery('d-past', 'completed', new Date(fixedNow - window - 1).toISOString());

        const removed = store.pruneTerminalSessionDeliveries(window);
        expect(removed).toBe(1);
        // Only the 1ms-past row was deleted; the boundary row survives.
        expect(store.getActiveSessionDeliveries(MESH)).toHaveLength(0);
    });

    it('is restart-repeat idempotent: a second sweep prunes nothing', () => {
        const store = MeshRuntimeStore.getInstance();
        insertDelivery('d-old', 'completed', isoAgo(30 * DAY_MS));
        expect(store.pruneTerminalSessionDeliveries(DEFAULT_SESSION_DELIVERY_RETENTION_MS)).toBe(1);
        // Re-open the store (restart) and re-run: nothing left to prune.
        __resetMeshRuntimeStoreForTests();
        const store2 = MeshRuntimeStore.getInstance();
        expect(store2.pruneTerminalSessionDeliveries(DEFAULT_SESSION_DELIVERY_RETENTION_MS)).toBe(0);
    });

    it('pruneMeshRuntimeRetention wires the session-delivery prune and reports its count', () => {
        insertDelivery('d-old-2', 'expired', isoAgo(30 * DAY_MS));
        insertDelivery('d-live', 'queued', isoAgo(30 * DAY_MS));
        const result = pruneMeshRuntimeRetention();
        expect(result.sessionDelivery).toBe(1);
        // Second run is a no-op for every table.
        const again = pruneMeshRuntimeRetention();
        expect(again.sessionDelivery).toBe(0);
    });

    it('honors the env-overridden retention window at sweep time', () => {
        process.env.MESH_SESSION_DELIVERY_RETENTION_MS = String(2 * DAY_MS);
        const store = MeshRuntimeStore.getInstance();
        insertDelivery('d-3d', 'completed', isoAgo(3 * DAY_MS));
        expect(store.pruneTerminalSessionDeliveries(resolveSessionDeliveryRetentionMs())).toBe(1);
    });
});

// ─── (2) config resolvers ────────────────────────────────────────────────────

describe('mesh-retention-config resolvers', () => {
    it('returns conservative defaults when env is unset or garbage', () => {
        expect(resolveSessionDeliveryRetentionMs()).toBe(14 * DAY_MS);
        expect(resolveLedgerRotationMaxBytes()).toBe(200 * MB);
        expect(resolveLedgerRotationMaxFiles()).toBe(DEFAULT_LEDGER_ROTATION_MAX_FILES);
        process.env.MESH_SESSION_DELIVERY_RETENTION_MS = 'not-a-number';
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = 'abc';
        expect(resolveSessionDeliveryRetentionMs()).toBe(14 * DAY_MS);
        expect(resolveLedgerRotationMaxBytes()).toBe(200 * MB);
    });

    it('clamps out-of-range values back to the defaults', () => {
        // Below the 1d floor / above the 90d ceiling.
        process.env.MESH_SESSION_DELIVERY_RETENTION_MS = String(60_000);
        expect(resolveSessionDeliveryRetentionMs()).toBe(DEFAULT_SESSION_DELIVERY_RETENTION_MS);
        process.env.MESH_SESSION_DELIVERY_RETENTION_MS = String(365 * DAY_MS);
        expect(resolveSessionDeliveryRetentionMs()).toBe(DEFAULT_SESSION_DELIVERY_RETENTION_MS);
        // Below the 16MB floor / above the 4GB ceiling.
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = String(1024);
        expect(resolveLedgerRotationMaxBytes()).toBe(DEFAULT_LEDGER_ROTATION_MAX_BYTES);
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = String(8 * 1024 * MB);
        expect(resolveLedgerRotationMaxBytes()).toBe(DEFAULT_LEDGER_ROTATION_MAX_BYTES);
        // Count cap outside [1, 50].
        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '0';
        expect(resolveLedgerRotationMaxFiles()).toBe(0); // 0 = disabled, honored
        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '500';
        expect(resolveLedgerRotationMaxFiles()).toBe(DEFAULT_LEDGER_ROTATION_MAX_FILES);
    });

    it('accepts in-range overrides and explicit 0 disables the byte cap', () => {
        process.env.MESH_SESSION_DELIVERY_RETENTION_MS = String(2 * DAY_MS);
        expect(resolveSessionDeliveryRetentionMs()).toBe(2 * DAY_MS);
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = String(32 * MB);
        expect(resolveLedgerRotationMaxBytes()).toBe(32 * MB);
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = '0';
        expect(resolveLedgerRotationMaxBytes()).toBe(0);
        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '3';
        expect(resolveLedgerRotationMaxFiles()).toBe(3);
    });
});

// ─── (3) rotation eviction planner (pure) ────────────────────────────────────

describe('planLedgerRotationEvictions (pure planner)', () => {
    const NOW = 1_700_000_000_000;
    const f = (name: string, sizeBytes: number, mtimeMs: number) => ({ name, sizeBytes, mtimeMs });

    it('evicts oldest-first by mtime until the byte total fits', () => {
        const files = [f('m.3.jsonl', 100, NOW), f('m.1.jsonl', 100, NOW - 3000), f('m.2.jsonl', 100, NOW - 1000)];
        const plan = planLedgerRotationEvictions(files, { maxFiles: 0, maxBytes: 150 });
        expect(plan.map(p => p.name)).toEqual(['m.1.jsonl', 'm.2.jsonl']);
        expect(plan.every(p => p.reason === 'rotation_cap_bytes')).toBe(true);
    });

    it('applies the count cap before the byte cap and credits count evictions against bytes', () => {
        const files = [f('m.1.jsonl', 100, NOW - 3000), f('m.2.jsonl', 100, NOW - 2000), f('m.3.jsonl', 100, NOW - 1000)];
        const plan = planLedgerRotationEvictions(files, { maxFiles: 2, maxBytes: 150 });
        // Count cap evicts m.1 (300→200 bytes); byte cap then evicts m.2 (200→100).
        expect(plan.map(p => [p.name, p.reason])).toEqual([
            ['m.1.jsonl', 'rotation_cap_count'],
            ['m.2.jsonl', 'rotation_cap_bytes'],
        ]);
    });

    it('breaks mtime ties by name for a deterministic order', () => {
        const files = [f('m.2.jsonl', 10, NOW), f('m.1.jsonl', 10, NOW)];
        const plan = planLedgerRotationEvictions(files, { maxFiles: 1, maxBytes: 0 });
        expect(plan.map(p => p.name)).toEqual(['m.1.jsonl']);
    });

    it('is disabled when both caps are 0', () => {
        const files = [f('m.1.jsonl', 10, NOW), f('m.2.jsonl', 10, NOW)];
        expect(planLedgerRotationEvictions(files, { maxFiles: 0, maxBytes: 0 })).toEqual([]);
    });
});

// ─── (4) rotation cap enforcement (files on temp root) ───────────────────────

describe('enforceLedgerRotationCap', () => {
    it('evicts only closed rotations — never the active ledger, current archive, rollup, or runtime DB', () => {
        writeLedgerFile(`${MESH}.jsonl`, [ledgerEntry('task_dispatched')]);
        writeLedgerFile(`${MESH}.archive.jsonl`, [ledgerEntry('task_completed')]);
        writeLedgerFile(`${MESH}.archived-counts.json`, [JSON.stringify({ taskCompleted: 1, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 1, lastArchivedAt: '' })]);
        writeLedgerFile(`${MESH}.1.jsonl`, [ledgerEntry('task_completed')], 1000);
        writeLedgerFile(`${MESH}.archive.1.jsonl`, [ledgerEntry('task_completed')], 2000);
        writeLedgerFile('mesh-runtime.db', ['db-bytes']);
        writeLedgerFile('mesh-runtime.db-wal', ['wal-bytes']);

        const r = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(r.applied.map(p => p.name).sort()).toEqual([`${MESH}.1.jsonl`, `${MESH}.archive.1.jsonl`]);

        const remaining = fs.readdirSync(getLedgerDir());
        expect(remaining).toContain(`${MESH}.jsonl`);              // active ledger
        expect(remaining).toContain(`${MESH}.archive.jsonl`);      // current archive append target
        expect(remaining).toContain(`${MESH}.archived-counts.json`); // rollup
        expect(remaining).toContain('mesh-runtime.db');            // runtime DB
        expect(remaining).toContain('mesh-runtime.db-wal');
        expect(remaining).not.toContain(`${MESH}.1.jsonl`);
        expect(remaining).not.toContain(`${MESH}.archive.1.jsonl`);
    });

    it('folds terminal aggregate counts into the archived-counts rollup before unlink', () => {
        // Pre-existing rollup counts must be added to, not replaced.
        writeLedgerFile(`${MESH}.archived-counts.json`, [JSON.stringify({ taskCompleted: 5, taskFailed: 1, taskStalled: 0, recoveryAttempted: 0, totalArchived: 6, lastArchivedAt: '' })]);
        writeLedgerFile(`${MESH}.1.jsonl`, [
            ledgerEntry('task_completed'),
            ledgerEntry('task_completed'),
            ledgerEntry('task_failed'),
            ledgerEntry('task_dispatched'), // non-terminal: counted in total only
            'not-json-corrupt-line',        // skipped, file still evicted
        ], 1000);

        const r = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(r.applied).toHaveLength(1);

        const counts = readArchivedCounts();
        expect(counts.taskCompleted).toBe(7);
        expect(counts.taskFailed).toBe(2);
        expect(counts.totalArchived).toBe(10); // 6 + 4 parseable entries
        expect(counts.evictedRotations).toContain(`${MESH}.1.jsonl`);
        expect(fs.existsSync(join(getLedgerDir(), `${MESH}.1.jsonl`))).toBe(false);
    });

    it('does NOT re-fold archive-family rotations (already counted at archive time)', () => {
        writeLedgerFile(`${MESH}.archived-counts.json`, [JSON.stringify({ taskCompleted: 3, taskFailed: 0, taskStalled: 0, recoveryAttempted: 0, totalArchived: 3, lastArchivedAt: '' })]);
        writeLedgerFile(`${MESH}.archive.1.jsonl`, [ledgerEntry('task_completed'), ledgerEntry('task_completed')], 1000);

        const r = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(r.applied).toHaveLength(1);

        const counts = readArchivedCounts();
        expect(counts.taskCompleted).toBe(3); // unchanged — no double count
        expect(counts.totalArchived).toBe(3);
        expect(counts.evictedRotations).toContain(`${MESH}.archive.1.jsonl`);
    });

    it('is crash/restart idempotent: a recorded-but-present file is unlinked without re-folding', () => {
        writeLedgerFile(`${MESH}.1.jsonl`, [ledgerEntry('task_completed')], 1000);
        const first = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(first.applied).toHaveLength(1);
        expect(readArchivedCounts().taskCompleted).toBe(1);

        // Simulate the crash window: the fold was recorded but the file is still
        // on disk (e.g. unlink interrupted). The next sweep must NOT re-fold.
        writeLedgerFile(`${MESH}.1.jsonl`, [ledgerEntry('task_completed'), ledgerEntry('task_failed')], 1000);
        const second = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(second.applied.map(p => p.name)).toEqual([`${MESH}.1.jsonl`]);
        const counts = readArchivedCounts();
        expect(counts.taskCompleted).toBe(1); // NOT re-folded
        expect(counts.taskFailed).toBe(0);
        expect(fs.existsSync(join(getLedgerDir(), `${MESH}.1.jsonl`))).toBe(false);

        // And a sweep with nothing over the cap is a stable no-op.
        const third = enforceLedgerRotationCap(MESH, { maxFiles: 0, maxBytes: 1 });
        expect(third.applied).toHaveLength(0);
        expect(readArchivedCounts().taskCompleted).toBe(1);
    });

    it('recovers from a per-mesh partial failure without blocking other meshes', () => {
        const BAD = 'badm';
        const GOOD = 'goodm';
        for (const m of [BAD, GOOD]) {
            writeLedgerFile(`${m}.1.jsonl`, [ledgerEntry('task_completed')], 1000);
            writeLedgerFile(`${m}.2.jsonl`, [ledgerEntry('task_completed')], 2000);
        }
        // Break ONLY badm's rollup path: a directory where the counts file belongs
        // makes the fold write fail for every badm eviction (partial failure).
        fs.mkdirSync(join(getLedgerDir(), `${BAD}.archived-counts.json`));

        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '1';
        const first = enforceAllLedgerRotationCaps();
        expect(first.evicted).toBe(1); // only goodm's oldest eviction succeeded
        expect(fs.existsSync(join(getLedgerDir(), `${GOOD}.1.jsonl`))).toBe(false);
        expect(fs.existsSync(join(getLedgerDir(), `${GOOD}.2.jsonl`))).toBe(true);
        expect(fs.existsSync(join(getLedgerDir(), `${BAD}.1.jsonl`))).toBe(true);
        expect(fs.existsSync(join(getLedgerDir(), `${BAD}.2.jsonl`))).toBe(true);

        // Recovery: fix the rollup path and re-run — badm is caught up.
        fs.rmSync(join(getLedgerDir(), `${BAD}.archived-counts.json`), { recursive: true, force: true });
        const second = enforceAllLedgerRotationCaps();
        expect(second.evicted).toBe(1);
        expect(fs.existsSync(join(getLedgerDir(), `${BAD}.1.jsonl`))).toBe(false);
        expect(fs.existsSync(join(getLedgerDir(), `${BAD}.2.jsonl`))).toBe(true);
    });

    it('evicts nothing when both caps are disabled via env', () => {
        writeLedgerFile(`${MESH}.1.jsonl`, [ledgerEntry('task_completed')], 1000);
        writeLedgerFile(`${MESH}.2.jsonl`, [ledgerEntry('task_completed')], 2000);
        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '0';
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = '0';
        const r = enforceAllLedgerRotationCaps();
        expect(r.evicted).toBe(0);
        expect(fs.existsSync(join(getLedgerDir(), `${MESH}.1.jsonl`))).toBe(true);
        expect(fs.existsSync(join(getLedgerDir(), `${MESH}.2.jsonl`))).toBe(true);
    });

    it('dry-run plans without folding, unlinking, or writing the rollup', () => {
        writeLedgerFile(`${MESH}.1.jsonl`, [ledgerEntry('task_completed')], 1000);
        writeLedgerFile(`${MESH}.2.jsonl`, [ledgerEntry('task_failed')], 2000);
        writeLedgerFile(`${MESH}.3.jsonl`, [ledgerEntry('task_stalled')], 3000);

        const r = enforceLedgerRotationCap(MESH, { maxFiles: 1, maxBytes: 0, dryRun: true });
        expect(r.dryRun).toBe(true);
        expect(r.planned.map(p => [p.name, p.reason])).toEqual([
            [`${MESH}.1.jsonl`, 'rotation_cap_count'],
            [`${MESH}.2.jsonl`, 'rotation_cap_count'],
        ]);
        expect(r.applied).toHaveLength(0);
        // Nothing applied: files intact, no rollup written.
        for (const n of ['1', '2', '3']) {
            expect(fs.existsSync(join(getLedgerDir(), `${MESH}.${n}.jsonl`))).toBe(true);
        }
        expect(fs.existsSync(join(getLedgerDir(), `${MESH}.archived-counts.json`))).toBe(false);

        // Sweep-level dry-run reports content-free metrics with reason codes.
        // (The sweep takes its caps from the env resolvers — wire a small cap in.)
        process.env.MESH_LEDGER_ROTATION_MAX_FILES = '1';
        const sweep = enforceAllLedgerRotationCaps({ dryRun: true });
        expect(sweep.meshes).toBe(1);
        expect(sweep.evicted).toBe(2);
        expect(sweep.byReason.rotation_cap_count).toBe(2);
        expect(sweep.byReason.rotation_cap_bytes).toBe(0);
    });
});
