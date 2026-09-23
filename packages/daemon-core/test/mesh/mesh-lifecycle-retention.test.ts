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
    getMachineId: () => (({ machineId: 'test-host-machine' }) as any).machineId,
    getMachineNickname: () => (({ machineId: 'test-host-machine' }) as any).machineNickname ?? null,
}));

import {
    MeshRuntimeStore,
    pruneMeshRuntimeRetention,
    MESH_TERMINAL_QUEUE_RETENTION_MS,
} from '../../src/mesh/mesh-runtime-store.js';
import { WORKER_HANDOFF_EVENT_KIND } from '../../src/mesh/worker-report.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import {
    getLedgerDir,
    planLedgerRotationEvictions,
    enforceLedgerRotationCap,
    enforceAllLedgerRotationCaps,
} from '../../src/mesh/mesh-ledger.js';
import {
    DEFAULT_TURN_ATTEMPT_RETENTION_MS,
    DEFAULT_LEDGER_ROTATION_MAX_BYTES,
    DEFAULT_LEDGER_ROTATION_MAX_FILES,
    resolveTurnAttemptRetentionMs,
    resolveLedgerRotationMaxBytes,
    resolveLedgerRotationMaxFiles,
} from '../../src/mesh/mesh-retention-config.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const MESH = 'mesh_lifecycle_test';
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const RETENTION_ENV_VARS = [
    'MESH_TURN_ATTEMPT_RETENTION_MS',
    'MESH_LEDGER_ROTATION_MAX_BYTES',
    'MESH_LEDGER_ROTATION_MAX_FILES',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
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

// ─── (2) config resolvers ────────────────────────────────────────────────────

describe('mesh-retention-config resolvers', () => {
    it('returns conservative defaults when env is unset or garbage', () => {
        expect(resolveLedgerRotationMaxBytes()).toBe(200 * MB);
        expect(resolveLedgerRotationMaxFiles()).toBe(DEFAULT_LEDGER_ROTATION_MAX_FILES);
        process.env.MESH_LEDGER_ROTATION_MAX_BYTES = 'abc';
        expect(resolveLedgerRotationMaxBytes()).toBe(200 * MB);
    });

    it('clamps out-of-range values back to the defaults', () => {
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

// ─── (1b) turn-ledger mesh attempt retention (C-W8) ──────────────────────────

/** Seeds one mesh attempt on the turn ledger; `terminalAt` commits it at that time (also its updated_at). */
function insertAttempt(opts: {
    attemptId: string;
    taskId: string;
    attemptNo: number;
    sessionId: string;
    terminalAt?: string;
    createdAt?: string;
    scope?: 'mesh_queue' | 'plain';
}): void {
    const at = Date.parse(opts.terminalAt ?? opts.createdAt ?? new Date().toISOString());
    seedMeshAttempt({
        meshId: MESH, taskId: opts.taskId, sessionId: opts.sessionId, attemptId: opts.attemptId,
        attemptNo: opts.attemptNo, stage: opts.terminalAt ? 'completed' : 'generating', nowMs: at,
        ...(opts.scope ? { scope: opts.scope } : {}),
    });
}

function attemptExists(attemptId: string): boolean {
    return MeshRuntimeStore.getInstance().turnStore().getAttempt(attemptId) !== null;
}

function prune(): { attempts: number; events: number; holds: number } {
    return MeshRuntimeStore.getInstance().turnStore().pruneTerminalMeshAttempts(DEFAULT_TURN_ATTEMPT_RETENTION_MS, Date.now());
}

describe('pruneTerminalMeshAttempts', () => {
    it('deletes aged terminal mesh attempts but never nonterminal or plain ones, at any age', () => {
        const aged = isoAgo(45 * DAY_MS);
        insertAttempt({ attemptId: 'a-old-1', taskId: 't-old', attemptNo: 0, sessionId: 'sess-old', terminalAt: aged });
        insertAttempt({ attemptId: 'a-old-2', taskId: 't-old', attemptNo: 1, sessionId: 'sess-old', terminalAt: aged });
        // The session's newest attempt is its anchor — keep it fresh so the two aged rows are prunable.
        insertAttempt({ attemptId: 'a-anchor', taskId: 't-anchor', attemptNo: 0, sessionId: 'sess-old', terminalAt: isoAgo(1 * DAY_MS) });
        // Aged but NONTERMINAL → the live set; never pruned however old.
        insertAttempt({ attemptId: 'a-active', taskId: 't-active', attemptNo: 0, sessionId: 'sess-active', createdAt: aged });
        // Plain (non-mesh) attempts are the scheduler's own prune.
        insertAttempt({ attemptId: 'a-plain-1', taskId: 't-plain', attemptNo: 0, sessionId: 'sess-plain', terminalAt: aged, scope: 'plain' });
        insertAttempt({ attemptId: 'a-plain-2', taskId: 't-plain', attemptNo: 1, sessionId: 'sess-plain', terminalAt: isoAgo(DAY_MS), scope: 'plain' });

        expect(prune().attempts).toBe(2);
        expect(attemptExists('a-old-1')).toBe(false);
        expect(attemptExists('a-old-2')).toBe(false);
        expect(attemptExists('a-anchor')).toBe(true);
        expect(attemptExists('a-active')).toBe(true);
        expect(attemptExists('a-plain-1')).toBe(true);
    });

    it("preserves each session's newest attempt regardless of age", () => {
        insertAttempt({ attemptId: 'a-s1', taskId: 't-s', attemptNo: 0, sessionId: 'sess-1', terminalAt: isoAgo(60 * DAY_MS) });
        insertAttempt({ attemptId: 'a-s2', taskId: 't-s', attemptNo: 1, sessionId: 'sess-1', terminalAt: isoAgo(50 * DAY_MS) });
        insertAttempt({ attemptId: 'a-s3', taskId: 't-s', attemptNo: 2, sessionId: 'sess-1', terminalAt: isoAgo(40 * DAY_MS) });

        expect(prune().attempts).toBe(2);
        // Stage 6 resolves a session with no time bound: deleting its last row would
        // blank the session's displayed state rather than age out history.
        expect(attemptExists('a-s3')).toBe(true);
        expect(attemptExists('a-s1')).toBe(false);
        expect(attemptExists('a-s2')).toBe(false);
        expect(MeshRuntimeStore.getInstance().turnStore().findPresentationAttemptForSession('sess-1')?.attempt.attemptId).toBe('a-s3');
    });

    it('cascades the attempt\'s turn events and holds; an attempt holding a handoff-note index row is kept', () => {
        const aged = isoAgo(45 * DAY_MS);
        const store = MeshRuntimeStore.getInstance().turnStore();
        insertAttempt({ attemptId: 'a-c1', taskId: 't-c', attemptNo: 0, sessionId: 'sess-c', terminalAt: aged });
        insertAttempt({ attemptId: 'a-c2', taskId: 't-c', attemptNo: 1, sessionId: 'sess-c', terminalAt: aged });
        insertAttempt({ attemptId: 'a-c-anchor', taskId: 't-c2', attemptNo: 0, sessionId: 'sess-c', terminalAt: isoAgo(DAY_MS) });
        store.insertWorkerEvent({ eventId: 'e-c1', attemptId: 'a-c1', kind: 'worker_progress_update', dedupeKey: '1', payload: {}, atMs: Date.parse(aged) });
        store.insertWorkerEvent({ eventId: 'e-c2-handoff', attemptId: 'a-c2', kind: WORKER_HANDOFF_EVENT_KIND, dedupeKey: '', payload: {}, atMs: Date.parse(aged) });
        store.syncHolds('a-c1', [{ holdId: 'a-c1:hard_ceiling', attemptId: 'a-c1', generation: null, reason: 'hard_ceiling', until: null, onExpire: 'commit', data: {}, createdAt: Date.parse(aged) }], Date.parse(aged));

        const r = prune();
        expect(r).toEqual({ attempts: 1, events: 1, holds: 1 });
        expect(attemptExists('a-c1')).toBe(false);
        // The handoff note's index reads through a join to its attempt, so the
        // attempt outlives the turn window until the handoff sweep collects the note.
        expect(attemptExists('a-c2')).toBe(true);
        expect(store.listWorkerEventsByKind(MESH, WORKER_HANDOFF_EVENT_KIND, 10).map((e) => e.eventId)).toEqual(['e-c2-handoff']);
    });

    it('is wired into the periodic sweep and reports content-free counts', () => {
        insertAttempt({ attemptId: 'a-sweep-1', taskId: 't-sweep', attemptNo: 0, sessionId: 'sess-sweep', terminalAt: isoAgo(45 * DAY_MS) });
        insertAttempt({ attemptId: 'a-sweep-2', taskId: 't-sweep', attemptNo: 1, sessionId: 'sess-sweep', terminalAt: isoAgo(44 * DAY_MS) });
        insertAttempt({ attemptId: 'a-sweep-3', taskId: 't-sweep2', attemptNo: 0, sessionId: 'sess-sweep', terminalAt: isoAgo(DAY_MS) });

        const swept = pruneMeshRuntimeRetention();
        expect(swept.turnAttempts).toBe(2);
        expect(attemptExists('a-sweep-1')).toBe(false);
        expect(attemptExists('a-sweep-2')).toBe(false);
    });
});

describe('resolveTurnAttemptRetentionMs', () => {
    it('defaults to 30 days, aligned with the terminal mesh_queue window', () => {
        expect(resolveTurnAttemptRetentionMs()).toBe(DEFAULT_TURN_ATTEMPT_RETENTION_MS);
        expect(DEFAULT_TURN_ATTEMPT_RETENTION_MS).toBe(30 * DAY_MS);
        expect(DEFAULT_TURN_ATTEMPT_RETENTION_MS).toBe(MESH_TERMINAL_QUEUE_RETENTION_MS);
    });

    it('honours an in-range env override and clamps out-of-range values to the default', () => {
        process.env.MESH_TURN_ATTEMPT_RETENTION_MS = String(7 * DAY_MS);
        expect(resolveTurnAttemptRetentionMs()).toBe(7 * DAY_MS);
        // Below the 1d floor: a mis-set env must not prune rows recovery still needs.
        process.env.MESH_TURN_ATTEMPT_RETENTION_MS = String(60 * 1000);
        expect(resolveTurnAttemptRetentionMs()).toBe(DEFAULT_TURN_ATTEMPT_RETENTION_MS);
        // Above the 90d ceiling: retention must not be disabled by accident.
        process.env.MESH_TURN_ATTEMPT_RETENTION_MS = String(365 * DAY_MS);
        expect(resolveTurnAttemptRetentionMs()).toBe(DEFAULT_TURN_ATTEMPT_RETENTION_MS);
        process.env.MESH_TURN_ATTEMPT_RETENTION_MS = 'not-a-number';
        expect(resolveTurnAttemptRetentionMs()).toBe(DEFAULT_TURN_ATTEMPT_RETENTION_MS);
    });
});
