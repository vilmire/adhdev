// ---------------------------------------------------------------------------
// lifecycle retention Slice 1 — turn-attempt age pruning + retention config
// resolvers (the ledger rotation caps retired with the JSONL mirror, C-W9a).
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
import { getLedgerDir } from '../../src/mesh/mesh-ledger-paths.js';
import {
    DEFAULT_TURN_ATTEMPT_RETENTION_MS,
    resolveTurnAttemptRetentionMs,
} from '../../src/mesh/mesh-retention-config.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const MESH = 'mesh_lifecycle_test';
const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION_ENV_VARS = [
    'MESH_TURN_ATTEMPT_RETENTION_MS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
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

// ─── (2)/(3) the ledger rotation cap and its resolvers retired with the JSONL
// mirror (C-W9a); leftover rotations age out through the disk sweep's 30-day pass.

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
