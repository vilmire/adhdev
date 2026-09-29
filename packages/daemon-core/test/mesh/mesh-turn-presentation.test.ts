import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts) so this suite's turn tables stay free of sibling rows.
const testTmpDir = join(tmpdir(), `adhdev-turn-presentation-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { seedMeshAttempt, advanceSeededAttempt, type SeedTurnStage } from '../helpers/turn-attempt-seed.js';
import {
    resolveSessionTurnPresentation,
    resolveTurnAttemptRow,
    turnStageToSurfaceStatus,
    isRestartBlockingPresentation,
    getTurnPresentationMetrics,
    STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS,
    __resetTurnPresentationMetricsForTests,
} from '../../src/mesh/mesh-turn-presentation.js';
import { normalizeManagedStatus } from '../../src/status/normalize.js';
import { validateReadChatResultPayload } from '../../src/providers/read-chat-contract.js';

const MESH = `mesh-${randomUUID().slice(0, 8)}`;

// C-W8: the presentation reads the turn ledger's `turn_attempts`. These are
// SURFACE tests, so rows are seeded in the surface vocabulary (reducer
// semantics — exactly-once commits, stale-attempt fences — are covered by
// test/turn-ledger/**).
function openAttempt(args: { taskId: string; sessionId: string; providerType?: string; nowMs?: number }) {
    return seedMeshAttempt({
        meshId: MESH,
        taskId: args.taskId,
        sessionId: args.sessionId,
        providerType: args.providerType ?? 'kimi-cli',
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    });
}

function attemptIdFor(taskId: string): string {
    const found = MeshRuntimeStore.getInstance().turnStore().findLatestAttemptForTask(MESH, taskId);
    if (!found) throw new Error(`no attempt for ${taskId}`);
    return found.attemptId;
}

function advance(taskId: string, stage: SeedTurnStage, nowMs?: number): void {
    advanceSeededAttempt(attemptIdFor(taskId), stage, nowMs !== undefined ? { nowMs } : {});
}

function driveToGenerating(_meshId: string, taskId: string, _sessionId: string, nowMs?: number): void {
    advance(taskId, 'generating', nowMs);
}

beforeEach(() => {
    MeshRuntimeStore.resetForTests();
    __resetTurnPresentationMetricsForTests();
});

afterAll(() => {
    MeshRuntimeStore.resetForTests();
    rmSync(testTmpDir, { recursive: true, force: true });
});

describe('authority selector', () => {
    it('falls back to the persisted provider FSM when no attempt exists (any provider)', () => {
        for (const providerType of ['kimi-cli', 'codex-cli', 'claude-cli', 'hermes-cli']) {
            const p = resolveSessionTurnPresentation({
                sessionId: `sess-${providerType}`,
                providerStatus: 'generating',
                providerType,
                surface: 'session_status',
            });
            expect(p.authority).toBe('provider_fsm_fallback');
            expect(p.status).toBe('generating');
            expect(p.stage).toBeNull();
            expect(p.attemptId).toBeNull();
        }
        const metrics = getTurnPresentationMetrics();
        expect(metrics.projectionSource.provider_fsm_fallback).toBe(4);
        expect(metrics.projectionSource.turn_reducer).toBe(0);
    });

    it('reducer projection is authoritative when an attempt exists; provider name plays no role', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'codex-cli' });
        const p = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            providerType: 'codex-cli',
            surface: 'read_chat',
        });
        expect(p.authority).toBe('turn_reducer');
        expect(p.stage).toBe('accepted');
        expect(p.status).toBe('starting');
        expect(p.taskId).toBe(taskId);
        expect(p.meshId).toBe(MESH);
        expect(p.attemptId).toBeTruthy();
    });

    it('a plain-scope (non-mesh) ledger attempt never takes authority — the provider FSM governs (C-W8)', () => {
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        seedMeshAttempt({ meshId: MESH, taskId: `plain-${randomUUID().slice(0, 8)}`, sessionId, scope: 'plain', stage: 'generating' });
        const p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'idle', providerType: 'claude-cli', surface: 'session_status' });
        expect(p.authority).toBe('provider_fsm_fallback');
        expect(p.status).toBe('idle');
        expect(resolveTurnAttemptRow({ sessionId })).toBeNull();
    });

    it('resolves the same projection by (meshId, taskId) and by sessionId (surface equivalence)', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const attempt = openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);

        const byTask = resolveSessionTurnPresentation({ meshId: MESH, taskId, providerStatus: 'generating', surface: 'active_work' });
        const bySession = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'session_status' });
        const byReadChat = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'read_chat' });
        const byMeshStatus = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'mesh_status' });
        const byDashboard = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'dashboard' });

        for (const p of [byTask, bySession, byReadChat, byMeshStatus, byDashboard]) {
            expect(p.authority).toBe('turn_reducer');
            expect(p.stage).toBe('generating');
            expect(p.status).toBe('generating');
            expect(p.attemptId).toBe(attempt.attemptId);
            expect(p.terminalOutcome).toBeNull();
        }
    });
});

describe('stage → surface status mapping', () => {
    it('maps every causal stage deterministically', () => {
        expect(turnStageToSurfaceStatus('accepted')).toBe('starting');
        expect(turnStageToSurfaceStatus('delivered')).toBe('starting');
        expect(turnStageToSurfaceStatus('consumed')).toBe('generating');
        expect(turnStageToSurfaceStatus('generating')).toBe('generating');
        expect(turnStageToSurfaceStatus('waiting_approval')).toBe('waiting_approval');
        expect(turnStageToSurfaceStatus('waiting_choice')).toBe('waiting_choice');
        expect(turnStageToSurfaceStatus('finalizing')).toBe('finalizing');
        expect(turnStageToSurfaceStatus('completed')).toBe('idle');
        expect(turnStageToSurfaceStatus('failed')).toBe('error');
        expect(turnStageToSurfaceStatus('cancelled')).toBe('stopped');
    });

    it('normalizeManagedStatus passes finalizing through (never collapses to idle)', () => {
        expect(normalizeManagedStatus('finalizing')).toBe('finalizing');
        expect(normalizeManagedStatus('waiting_choice')).toBe('waiting_choice');
    });

    it('read_chat contract accepts finalizing and waiting_choice statuses', () => {
        const base = { messages: [] };
        expect(validateReadChatResultPayload({ ...base, status: 'finalizing' }).status).toBe('finalizing');
        expect(validateReadChatResultPayload({ ...base, status: 'waiting_choice' }).status).toBe('waiting_choice');
    });
});

describe('Kimi/Codex mid-turn point samples cannot override the projection', () => {
    it('PTy briefly idle / interim narration while generating: every surface stays generating', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'kimi-cli' });
        driveToGenerating(MESH, taskId, sessionId);

        // Fresh point-sample reads idle (Kimi native transcript growing / PTY quiet)
        // or a settled Codex prompt sample — the projection still says generating.
        for (const sample of ['idle', 'no_progress', 'long_generating'] as const) {
            const p = resolveSessionTurnPresentation({ sessionId, providerStatus: sample, providerType: 'kimi-cli', surface: 'read_chat' });
            expect(p.status).toBe('generating');
            expect(p.stage).toBe('generating');
        }
        // The reducer is the only source: every resolution counts as turn_reducer.
        expect(getTurnPresentationMetrics().projectionSource.turn_reducer).toBeGreaterThanOrEqual(3);
    });
});

describe('provider idle while the reducer is finalizing', () => {
    it('all surfaces report finalizing; the restart gate blocks; no terminal is written', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);
        advance(taskId, 'finalizing');

        for (const surface of ['read_chat', 'session_status', 'mesh_status', 'dashboard', 'mcp_pending', 'restart_gate'] as const) {
            const p = resolveSessionTurnPresentation({ meshId: MESH, taskId, sessionId, providerStatus: 'idle', surface });
            expect(p.status).toBe('finalizing');
            expect(p.stage).toBe('finalizing');
            expect(p.terminalOutcome).toBeNull();
            expect(p.finalizingAgeMs).not.toBeNull();
            expect(isRestartBlockingPresentation(p, false)).toBe(true);
        }
        // No terminal commit happened — the attempt is still nonterminal.
        const row = resolveTurnAttemptRow({ meshId: MESH, taskId });
        expect(row?.terminalOutcome).toBeNull();
    });
});

describe('waiting_approval vs waiting_choice stay distinct', () => {
    it('approval and choice are separate stages/surfaces and resume continues the same attempt', () => {
        const approvalTask = `task-${randomUUID().slice(0, 8)}`;
        const choiceTask = `task-${randomUUID().slice(0, 8)}`;
        const approvalSession = `sess-${randomUUID().slice(0, 8)}`;
        const choiceSession = `sess-${randomUUID().slice(0, 8)}`;
        const approvalAttempt = openAttempt({ taskId: approvalTask, sessionId: approvalSession });
        const choiceAttempt = openAttempt({ taskId: choiceTask, sessionId: choiceSession });
        driveToGenerating(MESH, approvalTask, approvalSession);
        driveToGenerating(MESH, choiceTask, choiceSession);

        advance(approvalTask, 'waiting_approval');
        advance(choiceTask, 'waiting_choice');

        const approval = resolveSessionTurnPresentation({ sessionId: approvalSession, providerStatus: 'waiting_approval', surface: 'read_chat' });
        const choice = resolveSessionTurnPresentation({ sessionId: choiceSession, providerStatus: 'idle', surface: 'dashboard' });
        expect(approval.status).toBe('waiting_approval');
        expect(approval.stage).toBe('waiting_approval');
        expect(approval.approvalAgeMs).not.toBeNull();
        expect(choice.status).toBe('waiting_choice');
        expect(choice.stage).toBe('waiting_choice');
        expect(choice.choiceAgeMs).not.toBeNull();

        // Resume (generating) continues the SAME attempt — no new attemptId.
        advance(approvalTask, 'generating');
        const resumed = resolveSessionTurnPresentation({ sessionId: approvalSession, providerStatus: 'generating', surface: 'session_status' });
        expect(resumed.stage).toBe('generating');
        expect(resumed.attemptId).toBe(approvalAttempt.attemptId);
        expect(resumed.attemptId).not.toBe(choiceAttempt.attemptId);
    });
});

describe('committed terminal projection', () => {
    it('completed commits once; repeated reads are stable and do not re-complete', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);

        advance(taskId, 'completed');

        const first = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'notification' });
        expect(first.stage).toBe('completed');
        expect(first.status).toBe('idle'); // availability, not a completion writer
        expect(first.terminalOutcome).toBe('completed');
        expect(first.terminalAt).toBeTruthy();
        // The terminal commit frees the restart gate even when a stale provider
        // sample still reads generating.
        expect(isRestartBlockingPresentation(first, true)).toBe(false);

        // Repeated reads are stable (exactly-once commit is the reducer's contract,
        // covered by test/turn-ledger/**).
        const second = resolveSessionTurnPresentation({ meshId: MESH, taskId, providerStatus: 'generating', surface: 'mcp_pending' });
        expect(second.attemptId).toBe(first.attemptId);
        expect(second.terminalOutcome).toBe('completed');
    });

    it('cancelled is terminal and maps to stopped', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        advance(taskId, 'cancelled');
        const p = resolveSessionTurnPresentation({ sessionId, surface: 'session_status' });
        expect(p.stage).toBe('cancelled');
        expect(p.status).toBe('stopped');
    });
});

describe('single authority (no legacy shadow path)', () => {
    it('a mesh attempt ignores the provider status entirely', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId, providerType: 'codex-cli' });
        driveToGenerating(MESH, taskId, sessionId);
        const p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'idle', providerType: 'codex-cli', surface: 'read_chat' });
        expect(p.authority).toBe('turn_reducer');
        expect(p.status).toBe('generating');
        const metrics = getTurnPresentationMetrics() as unknown as Record<string, unknown>;
        expect(Object.keys(metrics).some((key) => /shadow/i.test(key))).toBe(false);
    });

    it('the presentation module carries no shadow comparator', async () => {
        const mod = await import('../../src/mesh/mesh-turn-presentation.js') as Record<string, unknown>;
        expect(mod.classifyShadowDivergence).toBeUndefined();
    });
});


describe('restart / deferred-restart gate', () => {
    it('blocks on every nonterminal stage and never on terminal, regardless of the sample', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });

        // accepted: blocks even though the provider sample is idle.
        let p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        driveToGenerating(MESH, taskId, sessionId);
        advance(taskId, 'waiting_choice');
        p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        advance(taskId, 'finalizing');
        p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'idle', surface: 'restart_gate' });
        expect(isRestartBlockingPresentation(p, false)).toBe(true);

        advance(taskId, 'failed');
        p = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'restart_gate' });
        expect(p.status).toBe('error');
        expect(isRestartBlockingPresentation(p, true)).toBe(false);
    });

    it('non-mesh sessions keep the legacy sample verdict', () => {
        const p = resolveSessionTurnPresentation({ sessionId: `sess-${randomUUID().slice(0, 8)}`, providerStatus: 'generating', surface: 'restart_gate' });
        expect(p.authority).toBe('provider_fsm_fallback');
        expect(isRestartBlockingPresentation(p, true)).toBe(true);
        expect(isRestartBlockingPresentation(p, false)).toBe(false);
    });
});

describe('session → attempt resolution', () => {
    it('prefers the nonterminal attempt; falls back to the latest terminal row', () => {
        const taskA = `task-${randomUUID().slice(0, 8)}`;
        const taskB = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        // Older, completed attempt on the same session (an earlier turn).
        openAttempt({ taskId: taskA, sessionId, nowMs: Date.now() - 60_000 });
        advance(taskA, 'completed', Date.now() - 50_000);
        // Current nonterminal attempt.
        const current = openAttempt({ taskId: taskB, sessionId });
        const row = resolveTurnAttemptRow({ sessionId });
        expect(row?.attemptId).toBe(current.attemptId);
        expect(row?.terminalOutcome).toBeNull();
    });

    it('returns the latest terminal attempt when no nonterminal row exists', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const attempt = openAttempt({ taskId, sessionId });
        advance(taskId, 'completed');
        const row = resolveTurnAttemptRow({ sessionId });
        expect(row?.attemptId).toBe(attempt.attemptId);
        expect(row?.terminalOutcome).toBe('completed');
    });
});

describe('restart reconstruction', () => {
    it('produces the identical projection before and after a daemon restart', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const attempt = openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);

        const before = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'session_status' });
        expect(before.stage).toBe('generating');

        // Simulate a daemon restart: drop the in-memory store singleton — the
        // attempt rows persist in SQLite and the next resolve reopens them.
        MeshRuntimeStore.resetForTests();

        const after = resolveSessionTurnPresentation({ sessionId, providerStatus: 'generating', surface: 'session_status' });
        expect(after.authority).toBe('turn_reducer');
        expect(after.attemptId).toBe(attempt.attemptId);
        expect(after.stage).toBe(before.stage);
        expect(after.status).toBe(before.status);
        expect(after.consumedAt).toBe(before.consumedAt);
        expect(after.terminalOutcome).toBeNull();
    });

    it('a committed terminal projection survives restart and stays exactly-once', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);
        advance(taskId, 'completed');

        MeshRuntimeStore.resetForTests();

        const p = resolveSessionTurnPresentation({ sessionId, surface: 'notification' });
        expect(p.stage).toBe('completed');
        expect(p.terminalOutcome).toBe('completed');
    });
});

describe('observability', () => {
    it('exposes bounded projection-source and age gauges, content-free', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        openAttempt({ taskId, sessionId });
        driveToGenerating(MESH, taskId, sessionId);
        advance(taskId, 'waiting_approval');

        resolveSessionTurnPresentation({ sessionId, providerStatus: 'waiting_approval', surface: 'dashboard' });
        resolveSessionTurnPresentation({ sessionId: `sess-${randomUUID().slice(0, 8)}`, providerStatus: 'idle', surface: 'dashboard' });

        const metrics = getTurnPresentationMetrics();
        expect(metrics.projectionSource.turn_reducer).toBe(1);
        expect(metrics.projectionSource.provider_fsm_fallback).toBe(1);
        expect(metrics.maxProjectionAgeMs).toBeGreaterThanOrEqual(0);
        expect(metrics.maxApprovalAgeMs).toBeGreaterThanOrEqual(0);
        // No transcript/prompt content anywhere in the metrics payload.
        const serialized = JSON.stringify(metrics);
        expect(serialized).not.toContain('content');
    });
});

describe('stale in-flight attempt max-age gate', () => {
    /**
     * REGRESSION (stranded `generating` anchor): a task completes normally but its
     * `mesh_queue` row is later removed by retention prune. Neither reclaim path
     * can close the attempt (no higher-seq sibling for reclaimOrphanedTurnAttempts;
     * no queue row for reclaimQueueTerminatedTurnAttempts), so the nonterminal row
     * kept every surface pinned to `generating` forever while PTY/adapter/parser
     * all read `idle`. The max-age gate demotes such a row to the provider FSM.
     */
    function staleGeneratingSession(): { sessionId: string; startedMs: number } {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const startedMs = Date.parse('2026-09-02T05:00:00.000Z');
        openAttempt({ taskId, sessionId, nowMs: startedMs });
        advance(taskId, 'delivered', startedMs);
        advance(taskId, 'consumed', startedMs);
        // `nowMs` (not `occurredAtMs`) is what stamps `updated_at` — the column the
        // max-age gate reads. Passing only `occurredAtMs` leaves the row wall-clock fresh.
        advance(taskId, 'generating', startedMs);
        return { sessionId, startedMs };
    }

    it('demotes a stranded `generating` row so the provider FSM idle reaches the surface', () => {
        const { sessionId, startedMs } = staleGeneratingSession();

        const p = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            surface: 'read_chat',
            nowMs: startedMs + STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS + 60_000,
        });

        expect(p.authority).toBe('provider_fsm_fallback');
        expect(p.status).toBe(normalizeManagedStatus('idle'));
        expect(p.stage).toBeNull();
    });

    it('keeps authority for a live `generating` row that was just written', () => {
        const { sessionId, startedMs } = staleGeneratingSession();

        const p = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            surface: 'read_chat',
            nowMs: startedMs + 1_000,
        });

        expect(p.authority).toBe('turn_reducer');
        expect(p.stage).toBe('generating');
        expect(p.status).toBe('generating');
    });

    it('is exclusive at the threshold: at the boundary authority holds, just past it demotes', () => {
        const { sessionId, startedMs } = staleGeneratingSession();

        const atBoundary = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            surface: 'read_chat',
            nowMs: startedMs + STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS,
        });
        expect(atBoundary.authority).toBe('turn_reducer');

        const pastBoundary = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            surface: 'read_chat',
            nowMs: startedMs + STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS + 1,
        });
        expect(pastBoundary.authority).toBe('provider_fsm_fallback');
    });

    it('never demotes long-lived-by-design suspensions (a human may not answer for hours)', () => {
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        const sessionId = `sess-${randomUUID().slice(0, 8)}`;
        const startedMs = Date.parse('2026-09-02T05:00:00.000Z');
        openAttempt({ taskId, sessionId, nowMs: startedMs });
        advance(taskId, 'delivered', startedMs);
        advance(taskId, 'consumed', startedMs);
        // `nowMs` (not `occurredAtMs`) is what stamps `updated_at` — the column the
        // max-age gate reads. Passing only `occurredAtMs` leaves the row wall-clock fresh.
        advance(taskId, 'generating', startedMs);
        advance(taskId, 'waiting_approval', startedMs);

        const p = resolveSessionTurnPresentation({
            sessionId,
            providerStatus: 'idle',
            surface: 'read_chat',
            nowMs: startedMs + STALE_TURN_ATTEMPT_AUTHORITY_MAX_AGE_MS * 10,
        });

        expect(p.authority).toBe('turn_reducer');
        expect(p.stage).toBe('waiting_approval');
    });
});
